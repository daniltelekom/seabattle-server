// index.js — SeaStrike realtime backend (Socket.IO, in-memory)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    transports: ['websocket', 'polling'],
  },
});

const PORT = process.env.PORT || 3000;

/*
 matches: {
   matchId: {
     id,
     players: [p1,p2],
     placements: {playerId:[ships]},
     shots: {playerId: Set(idx)},
     hits: {playerId: Set(idxHitOnThisPlayer)},
     sunk: {playerId: [ships]},
     turn,
     state: 'waiting'|'started'|'finished'|'aborted',
     rematchVotes: Set(playerId)
   }
 }
*/
const matches = new Map();
const sockets = new Map();          // playerId -> socketId
/** очередь поиска: [{ playerId, socketId }] */
const searchQueue = [];

// ===== Рейтинг игроков =====
const ratings = new Map();
const BASE_RATING = 1000;
const RATING_DELTA = 25;

// получить/инициализировать рейтинг игрока
function getRating(playerId) {
  playerId = String(playerId);
  if (!ratings.has(playerId)) {
    ratings.set(playerId, BASE_RATING);
  }
  return ratings.get(playerId);
}

// применить результат матча: winner +DELTA, loser -DELTA (но не ниже 0)
function applyMatchResult(winnerId, loserId) {
  winnerId = String(winnerId);
  loserId = String(loserId);

  const wOld = getRating(winnerId);
  const lOld = getRating(loserId);

  const wNew = wOld + RATING_DELTA;
  const lNew = Math.max(0, lOld - RATING_DELTA);

  ratings.set(winnerId, wNew);
  ratings.set(loserId, lNew);

  return { wNew, lNew };
}

/* helpers */
function cellIndex(x, y) {
  return y * 10 + x;
}
function genId(prefix = 'm') {
  return prefix + Math.random().toString(36).slice(2, 9);
}
function normalizeId(id) {
  return String(id);
}
function otherPlayer(match, playerId) {
  return match.players.find((p) => String(p) !== String(playerId));
}
function removeFromQueue(playerId) {
  const pid = normalizeId(playerId);
  const idx = searchQueue.findIndex((q) => String(q.playerId) === pid);
  if (idx !== -1) searchQueue.splice(idx, 1);
}

// центр. финиш матча + рейтинг
function finishMatch(match, winnerId, reason = 'ships') {
  if (!match) return;
  if (match.state === 'finished' || match.state === 'aborted') return;

  match.state = 'finished';
  match.winner = winnerId || null;

  let ratingsPayload = null;

  if (winnerId && Array.isArray(match.players) && match.players.length === 2) {
    const winner = String(winnerId);
    const loser = String(match.players.find((p) => String(p) !== winner));

    if (loser) {
      const { wNew, lNew } = applyMatchResult(winner, loser);
      ratingsPayload = {
        [winner]: wNew,
        [loser]: lNew,
      };
    }
  }

  // всем в комнате — матч завершён
  io.to(match.id).emit('match_finished', {
    matchId: match.id,
    winner: winnerId || null,
    reason,
    ratings: ratingsPayload,
  });

  // каждому отдельно — его новый рейтинг
  if (ratingsPayload) {
    Object.entries(ratingsPayload).forEach(([pid, rating]) => {
      const sId = sockets.get(pid);
      if (!sId) return;
      io.to(sId).emit('rating_update', {
        playerId: pid,
        rating,
      });
    });
  }
}

/* health */
app.get('/health', (req, res) =>
  res.json({ ok: true, service: 'SeaStrike Socket Server' })
);

/* socket */
io.on('connection', (socket) => {
  // identify
  socket.on('identify', (data = {}) => {
    try {
      const rawId = data.playerId ?? data.id ?? data.player;
      if (!rawId) {
        socket.emit('error', { error: 'no_player_id' });
        return;
      }
      const pid = normalizeId(rawId);
      sockets.set(pid, socket.id);
      socket.playerId = pid;

      socket.emit('identified', { ok: true, playerId: pid });

      // отдаем текущий рейтинг игрока
      const rating = getRating(pid);
      socket.emit('rating_info', { playerId: pid, rating });
    } catch (e) {
      console.error('identify error', e);
    }
  });

  // create_match (игра с другом)
  socket.on('create_match', (data = {}) => {
    const playerId = normalizeId(data.playerId);
    const mId = genId('m');
    const match = {
      id: mId,
      players: [playerId],
      placements: {},
      shots: {},
      hits: {},
      sunk: {},
      turn: playerId,
      state: 'waiting',
      rematchVotes: new Set(),
    };
    matches.set(mId, match);
    socket.join(mId);
    socket.emit('match_created', { matchId: mId });
  });

  // join_match (по ID)
  socket.on('join_match', (data = {}) => {
    const playerId = normalizeId(data.playerId);
    const matchId = data.matchId;
    const match = matches.get(matchId);
    if (!match) {
      socket.emit('error', { error: 'match_not_found' });
      return;
    }
    if (match.players.includes(playerId)) {
      socket.join(matchId);
      socket.emit('match_joined', { matchId, players: match.players });
      return;
    }
    if (match.players.length >= 2) {
      socket.emit('error', { error: 'match_full' });
      return;
    }
    match.players.push(playerId);
    socket.join(matchId);
    io.to(matchId).emit('match_joined', {
      matchId,
      players: match.players,
    });
  });

  // find_match (быстрый поиск)
  socket.on('find_match', (data = {}) => {
    const playerId = normalizeId(data.playerId);
    const socketId = socket.id;

    // не дублируем игрока в очереди
    if (!searchQueue.find((q) => q.playerId === playerId)) {
      searchQueue.push({ playerId, socketId });
    }

    if (searchQueue.length >= 2) {
      const a = searchQueue.shift(); // {playerId, socketId}
      const b = searchQueue.shift();

      const mId = genId('m');
      const match = {
        id: mId,
        players: [a.playerId, b.playerId],
        placements: {},
        shots: {},
        hits: {},
        sunk: {},
        turn: a.playerId, // первый в очереди ходит первым
        state: 'waiting',
        rematchVotes: new Set(),
      };
      matches.set(mId, match);

      // заводим оба сокета в комнату матча
      const sA = io.sockets.sockets.get(a.socketId);
      const sB = io.sockets.sockets.get(b.socketId);
      if (sA) sA.join(mId);
      if (sB) sB.join(mId);

      // шлём обоим match_found
      if (sA)
        sA.emit('match_found', {
          matchId: mId,
          players: match.players,
          turn: match.turn,
        });
      if (sB)
        sB.emit('match_found', {
          matchId: mId,
          players: match.players,
          turn: match.turn,
        });
    } else {
      socket.emit('find_ack', { status: 'queued' });
    }
  });

  // place_ships
  socket.on('place_ships', (data = {}) => {
    const playerId = normalizeId(data.playerId);
    const matchId = data.matchId;
    const ships = data.ships || [];
    const match = matches.get(matchId);
    if (!match) {
      socket.emit('error', { error: 'match_not_found' });
      return;
    }

    match.placements[playerId] = ships;
    match.shots[playerId] = match.shots[playerId] || new Set();
    match.hits[playerId] = match.hits[playerId] || new Set();

    io.to(matchId).emit('placement_update', { playerId });

    if (Object.keys(match.placements).length === 2 && match.state !== 'started') {
      match.state = 'started';
      match.turn = match.players[0]; // тот, кого мы первым записали
      io.to(matchId).emit('match_started', {
        matchId,
        turn: match.turn,
      });
    }
  });

  // equip_skin (пока просто ACK)
  socket.on('equip_skin', (data = {}) => {
    socket.emit('profile', { equippedSkin: data.skinId, ownedSkins: [] });
  });

  // buy_skin (мок)
  socket.on('buy_skin', (data = {}) => {
    const skinId = data.skinId;
    socket.emit('purchase_result', {
      ok: true,
      skinId,
      ownedSkins: [skinId],
    });
  });

  // shoot — правила: попал/потопил = ходишь ещё, промах = ход переходит
  socket.on('shoot', (data = {}, ackFn) => {
    try {
      const playerId = normalizeId(data.playerId);
      const matchId = data.matchId;
      const x = Number(data.x);
      const y = Number(data.y);
      const match = matches.get(matchId);
      if (!match) {
        ackFn && ackFn(null, { ok: false, error: 'match_not_found' });
        return;
      }
      if (match.state !== 'started') {
        ackFn && ackFn(null, { ok: false, error: 'match_not_started' });
        return;
      }
      if (String(match.turn) !== String(playerId)) {
        ackFn && ackFn(null, { ok: false, error: 'not_your_turn' });
        return;
      }

      const idx = cellIndex(x, y);
      match.shots[playerId] = match.shots[playerId] || new Set();

      // уже стреляли в эту клетку этим игроком
      if (match.shots[playerId].has(idx)) {
        ackFn &&
          ackFn(null, {
            ok: false,
            error: 'already_shot',
            existing: { player: playerId, x, y, idx },
          });
        return;
      }
      match.shots[playerId].add(idx);

      const oppId = otherPlayer(match, playerId);
      if (!oppId) {
        ackFn && ackFn(null, { ok: false, error: 'no_opponent' });
        return;
      }

      const oppShips = match.placements[oppId] || [];
      let hit = false,
        sunk = false,
        sunkShip = null;

      for (const ship of oppShips) {
        const cells = ship.cells || [];
        if (cells.includes(idx)) {
          hit = true;
          match.hits[oppId] = match.hits[oppId] || new Set();
          match.hits[oppId].add(idx);

          const allHit = cells.every((c) => match.hits[oppId].has(c));
          if (allHit) {
            sunk = true;
            sunkShip = {
              cells,
              size: ship.size,
              orientation: ship.orientation,
              skinId: ship.skinId || null,
              owner: oppId,
            };
          }
          break;
        }
      }

      const result = sunk ? 'sunk' : hit ? 'hit' : 'miss';
      let finished = false;
      let winner = null;

      if (sunk && sunkShip) {
        match.sunk[oppId] = match.sunk[oppId] || [];
        match.sunk[oppId].push(sunkShip);

        const totalParts = oppShips.reduce(
          (s, sh) => s + (sh.cells ? sh.cells.length : sh.size || 0),
          0
        );
        const hitCount = (match.hits[oppId] && match.hits[oppId].size) || 0;

        if (totalParts > 0 && hitCount >= totalParts) {
          finished = true;
          winner = playerId;
        }
      }

      // попал/потопил — ходишь ещё; промах — ход переходит
      if (!finished) {
        if (result === 'miss') {
          match.turn = oppId;
        } else {
          match.turn = playerId;
        }
      } else {
        match.turn = null;
      }

      const payload = {
        matchId,
        shooter: playerId,
        x,
        y,
        result,
        newTurn: finished ? null : match.turn,
        finished,
        winner,
        sunkShip,
      };

      // ACK стрелявшему
      ackFn && ackFn(null, { ok: true, ...payload });

      // всем в комнате
      io.to(matchId).emit('shot_result', payload);

      // если закончился — централизованно финишим матч (рейтинг+match_finished)
      if (finished) {
        finishMatch(match, winner, 'all_ships_destroyed');
      }
    } catch (e) {
      console.error('shoot error', e);
      ackFn && ackFn(null, { ok: false, error: 'server_error' });
    }
  });

  // запрос на реванш
  socket.on('request_rematch', (data = {}) => {
    try {
      const playerId = normalizeId(data.playerId);
      const matchId = data.matchId;
      const match = matches.get(matchId);

      if (!match) {
        socket.emit('error', { error: 'match_not_found' });
        return;
      }

      if (match.state !== 'finished') {
        socket.emit('error', { error: 'rematch_not_available' });
        return;
      }

      // заводим набор голосов за реванш
      if (!match.rematchVotes) match.rematchVotes = new Set();
      match.rematchVotes.add(playerId);

      // всем в матче говорим, что игрок попросил реванш
      io.to(matchId).emit('rematch_vote', { matchId, playerId });

      // если ещё не все согласились — просто ждём
      if (match.rematchVotes.size < match.players.length) {
        socket.emit('rematch_pending', { matchId });
        return;
      }

      // оба (или все) нажали реванш — стартуем новый раунд в том же матче
      match.state = 'waiting';
      match.placements = {};
      match.shots = {};
      match.hits = {};
      match.sunk = {};
      match.rematchVotes = new Set();
      // случайно выбираем, кто ходит первым
      const starterIdx = Math.floor(Math.random() * match.players.length);
      match.turn = match.players[starterIdx];

      io.to(matchId).emit('rematch_started', {
        matchId,
        turn: match.turn,
      });
    } catch (e) {
      console.error('request_rematch error', e);
      socket.emit('error', { error: 'server_error' });
    }
  });

  // leave
  socket.on('leave', (data = {}) => {
    const playerId = normalizeId(data.playerId);
    const matchId = data.matchId;
    const match = matches.get(matchId);

    removeFromQueue(playerId);

    if (match) {
      if (match.state === 'started') {
        // если матч шёл — засчитываем победу второму
        const winnerId = otherPlayer(match, playerId);
        finishMatch(match, winnerId, 'surrender');
      } else {
        match.state = 'aborted';
        io.to(matchId).emit('player_left', { playerId });
      }
      matches.delete(matchId);
    }

    sockets.delete(playerId);
    if (matchId) socket.leave(matchId);
  });

  socket.on('disconnect', () => {
    if (socket.playerId) {
      removeFromQueue(socket.playerId);
      sockets.delete(socket.playerId);
    }
  });
});

server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
