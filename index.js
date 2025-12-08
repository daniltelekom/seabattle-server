// server/index.js — SeaStrike realtime backend (Socket.IO, in-memory)
// Minimal, stable, ready for Railway. Uses shortid for match ids.

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const shortid = require('shortid');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// In-memory stores
const players = {};   // playerId -> { id, username, rating, stars, skins }
const matches = {};   // matchId -> { id, players: [p1,p2], placements:{pId:ships}, moves:[], turn, state, createdAt }
const queue = [];     // matchmaking queue (playerId order)
const sockets = {};   // playerId -> socket.id

// Helpers
function makePlayer(id, username='Player') {
  if (!players[id]) players[id] = { id, username, rating:1000, stars:0, skins:[] };
  return players[id];
}
function elo(Ra, Rb, scoreA, K = 32) {
  const expectedA = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
  return Math.round(Ra + K * (scoreA - expectedA));
}
function coordToIdx(x,y){ return y*10 + x; }
function idxToCoord(idx){ return { x: idx % 10, y: Math.floor(idx/10) }; }

// Evaluate shot and update match state
function evaluateShot(match, shooterId, x, y) {
  const idx = coordToIdx(x,y);
  const oppId = match.players.find(p => p !== shooterId);
  if (!oppId) return { error:'no_opponent' };
  const oppShips = match.placements[oppId] || [];
  const already = match.moves.find(m => m.idx === idx);
  if (already) return { error:'already_shot', existing: already };

  let result = 'miss', sunkShipId = null;
  for (const ship of oppShips) {
    if (ship && Array.isArray(ship.cells) && ship.cells.includes(idx)) {
      result = 'hit';
      // compute hits on this ship
      const hitIdxs = new Set(match.moves.filter(m => m.result !== 'miss' && ship.cells.includes(m.idx)).map(m => m.idx));
      hitIdxs.add(idx);
      if (ship.cells.every(c => hitIdxs.has(c))) {
        result = 'sunk';
        sunkShipId = ship.id || (ship._id || null);
      }
      break;
    }
  }

  // register move
  match.moves.push({ player: shooterId, x, y, idx, result, time: Date.now() });

  // switch turn
  match.turn = oppId;

  // check finish: are all opponent ship cells hit?
  const allHitIdxs = new Set(match.moves.filter(m => m.result !== 'miss').map(m => m.idx));
  if (match.placements[oppId] && match.placements[oppId].length > 0) {
    const allSunk = match.placements[oppId].every(ship => ship.cells.every(c => allHitIdxs.has(c)));
    if (allSunk) {
      match.state = 'finished';
      const winner = shooterId;
      match.result = { winner, finishedAt: Date.now() };
      // update elo and stars (simple)
      const loser = oppId;
      players[winner].rating = elo(players[winner].rating || 1000, players[loser].rating || 1000, 1);
      players[loser].rating = elo(players[loser].rating || 1000, players[winner].rating || 1000, 0);
      players[winner].stars = (players[winner].stars || 0) + 10;
      return { result, sunkShipId, finished: true, winner };
    }
  }

  return { result, sunkShipId, finished: false, newTurn: match.turn };
}

// Simple HTTP endpoints
app.get('/', (req,res) => res.send('SeaStrike Socket.IO backend'));
app.get('/health', (req,res) => res.json({ status:'ok' }));
app.get('/player/:id', (req,res) => {
  const p = players[String(req.params.id)];
  if (!p) return res.status(404).json({ error:'no_player' });
  return res.json(p);
});

// Socket.IO handlers
io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // Identify client
  socket.on('identify', (data = {}) => {
    try {
      const playerId = data.playerId ? String(data.playerId) : null;
      const username = data.username || ('p'+(playerId || '').slice(-4));
      if (!playerId) return socket.emit('error', { error:'no_playerId' });
      makePlayer(playerId, username);
      sockets[playerId] = socket.id;
      socket.data.playerId = playerId;
      socket.join('p-' + playerId);
      socket.emit('identified', { ok:true, player: players[playerId] });
      console.log('identified', playerId);
    } catch (err) {
      console.error('identify error', err);
    }
  });

  // Create match
  socket.on('create_match', ({ playerId } = {}) => {
    if (!playerId) return socket.emit('error', { error: 'no_playerId' });
    const id = 'm' + shortid.generate();
    matches[id] = { id, players: [String(playerId)], placements: {}, moves: [], turn: null, state: 'waiting', createdAt: Date.now() };
    socket.join(id);
    socket.emit('match_created', { matchId: id });
    console.log('match created', id, 'by', playerId);
  });

  // Join match by ID
  socket.on('join_match', ({ matchId, playerId } = {}) => {
    if (!matchId || !playerId) return socket.emit('error', { error: 'missing_params' });
    const m = matches[matchId];
    if (!m) return socket.emit('error', { error: 'no_match' });
    if (m.players.length >= 2) return socket.emit('error', { error: 'full' });
    m.players.push(String(playerId));
    socket.join(matchId);
    // ensure other socket joins room
    const otherSocketId = sockets[m.players[0]];
    if (otherSocketId) {
      const s = io.sockets.sockets.get(otherSocketId);
      if (s) s.join(matchId);
    }
    io.to(matchId).emit('match_joined', { matchId, players: m.players });
    console.log('player', playerId, 'joined match', matchId);
  });

  // Find match (queue)
  socket.on('find_match', ({ playerId } = {}) => {
    if (!playerId) return socket.emit('error', { error: 'no_playerId' });
    const pid = String(playerId);
    if (queue.includes(pid)) return socket.emit('searching', { status: 'searching' });
    if (queue.length > 0) {
      const opp = queue.shift();
      const id = 'm' + shortid.generate();
      matches[id] = { id, players: [pid, String(opp)], placements: {}, moves: [], turn: pid, state: 'waiting', createdAt: Date.now() };
      // join sockets if present
      const s1 = sockets[pid], s2 = sockets[opp];
      if (s1) io.sockets.sockets.get(s1)?.join(id);
      if (s2) io.sockets.sockets.get(s2)?.join(id);
      io.to(id).emit('match_found', { matchId: id, players: matches[id].players });
      console.log('match found', id, matches[id].players);
    } else {
      queue.push(pid);
      socket.emit('searching', { status: 'searching' });
    }
  });

  // Place ships
  socket.on('place_ships', ({ matchId, playerId, ships } = {}) => {
    if (!matchId || !playerId) return socket.emit('error', { error: 'missing_params' });
    const m = matches[matchId];
    if (!m) return socket.emit('error', { error: 'no_match' });
    // store ships - expected format: [{ id, size, cells: [idx,...], orientation, skinId }, ...]
    m.placements[String(playerId)] = Array.isArray(ships) ? ships : [];
    m.ready = m.ready || {};
    m.ready[String(playerId)] = true;
    io.to(matchId).emit('placement_update', { playerId, ships: m.placements[String(playerId)] });
    // if both ready -> start
    if (m.players.length === 2 && m.ready[m.players[0]] && m.ready[m.players[1]] && m.state !== 'started') {
      m.state = 'started';
      m.turn = m.players[0];
      io.to(matchId).emit('match_started', { matchId, turn: m.turn });
      console.log('match started', matchId);
    }
  });

  // Buy skin (mock)
  socket.on('buy_skin', ({ playerId, skinId } = {}) => {
    if (!playerId || !skinId) return socket.emit('purchase_result', { ok: false, error: 'missing_params' });
    makePlayer(String(playerId));
    players[playerId].skins = players[playerId].skins || [];
    if (!players[playerId].skins.includes(skinId)) players[playerId].skins.push(skinId);
    socket.emit('purchase_result', { ok: true, skinId, ownedSkins: players[playerId].skins });
  });

  // Equip skin (mock)
  socket.on('equip_skin', ({ playerId, skinId } = {}) => {
    if (!playerId) return socket.emit('error', { error: 'missing_params' });
    makePlayer(String(playerId));
    players[playerId].equippedSkin = skinId || null;
    socket.emit('profile', { equippedSkin: players[playerId].equippedSkin, ownedSkins: players[playerId].skins });
  });

  // SHOOT - safer version with lock & ack
  socket.on('shoot', async (data = {}, ackFn) => {
    try {
      const matchId = data.matchId;
      const playerId = data.playerId ? String(data.playerId) : null;
      const x = Number(data.x);
      const y = Number(data.y);

      if (!matchId || !playerId || Number.isNaN(x) || Number.isNaN(y)) {
        if (typeof ackFn === 'function') return ackFn(null, { ok: false, error: 'missing_params' });
        return socket.emit('error', { error: 'missing_params' });
      }

      const m = matches[matchId];
      if (!m) {
        if (typeof ackFn === 'function') return ackFn(null, { ok: false, error: 'no_match' });
        return socket.emit('error', { error: 'no_match' });
      }

      // lock per match
      if (m._lock) {
        if (typeof ackFn === 'function') return ackFn(null, { ok: false, error: 'busy' });
        return socket.emit('error', { error: 'busy' });
      }
      m._lock = true;

      try {
        if (m.state !== 'started') {
          if (typeof ackFn === 'function') return ackFn(null, { ok: false, error: 'not_started' });
          return socket.emit('error', { error: 'not_started' });
        }
        if (String(m.turn) !== String(playerId)) {
          if (typeof ackFn === 'function') return ackFn(null, { ok: false, error: 'not_your_turn' });
          return socket.emit('error', { error: 'not_your_turn' });
        }

        const ev = evaluateShot(m, playerId, x, y);
        if (ev.error) {
          if (typeof ackFn === 'function') return ackFn(null, { ok: false, error: ev.error, existing: ev.existing || null });
          return socket.emit('error', ev);
        }

        // prepare sunkShip details
        let sunkShip = null;
        if (ev.sunkShipId) {
          const oppId = m.players.find(p => p !== playerId);
          const oppShips = m.placements[oppId] || [];
          const ship = oppShips.find(s => String(s.id) === String(ev.sunkShipId) || s.id === ev.sunkShipId);
          if (ship) {
            sunkShip = { id: ship.id, size: ship.size || (ship.cells ? ship.cells.length : null), cells: ship.cells, orientation: ship.orientation || 'H', owner: oppId, skinId: ship.skinId || null };
          }
        }

        const ackPayload = {
          ok: true,
          result: ev.result,
          x, y,
          idx: coordToIdx(x,y),
          newTurn: ev.newTurn || m.turn,
          finished: !!ev.finished,
          winner: ev.winner || null,
          sunkShip
        };

        if (typeof ackFn === 'function') ackFn(null, ackPayload);

        // broadcast shot_result
        io.to(matchId).emit('shot_result', {
          matchId,
          shooter: playerId,
          x, y,
          idx: coordToIdx(x,y),
          result: ev.result,
          sunkShip,
          finished: !!ev.finished,
          winner: ev.winner || null,
          newTurn: ackPayload.newTurn
        });

        if (ev.finished) {
          io.to(matchId).emit('match_finished', { matchId, winner: ev.winner, result: m.result || null });
        }

      } finally {
        m._lock = false;
      }

    } catch (err) {
      console.error('shoot handler error', err);
      if (typeof ackFn === 'function') return ackFn(null, { ok: false, error: 'server_error' });
      socket.emit('error', { error: 'server_error' });
    }
  });

  // Leave handler
  socket.on('leave', ({ playerId, matchId } = {}) => {
    try {
      if (playerId) {
        const pid = String(playerId);
        const qidx = queue.indexOf(pid);
        if (qidx !== -1) queue.splice(qidx, 1);
      }

      if (matchId) {
        const m = matches[matchId];
        if (m) {
          m.players = m.players.filter(p => p !== String(playerId));
          io.to(matchId).emit('player_left', { playerId: String(playerId), matchId });

          if (m.players.length === 1) {
            const remaining = m.players[0];
            m.state = 'aborted';
            io.to(matchId).emit('match_aborted', { matchId, reason: 'opponent_left', remainingPlayer: remaining });
            delete matches[matchId];
          } else if (m.players.length === 0) {
            delete matches[matchId];
          }
        }
      }

      if (playerId) {
        delete sockets[String(playerId)];
        // remove any duplicates in queue
        let qi = queue.indexOf(String(playerId));
        while (qi !== -1) {
          queue.splice(qi, 1);
          qi = queue.indexOf(String(playerId));
        }
      }
    } catch (err) {
      console.error('leave handler error', err);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    try {
      const pid = socket.data && socket.data.playerId;
      if (pid) {
        const sId = String(pid);
        if (sockets[sId]) delete sockets[sId];
        const idx = queue.indexOf(sId);
        if (idx !== -1) queue.splice(idx, 1);

        // handle any matches with this player
        Object.keys(matches).forEach(matchId => {
          const m = matches[matchId];
          if (m && m.players.includes(sId)) {
            m.players = m.players.filter(p => p !== sId);
            io.to(matchId).emit('player_left', { playerId: sId, matchId });
            if (m.players.length === 1) {
              const remaining = m.players[0];
              m.state = 'aborted';
              io.to(matchId).emit('match_aborted', { matchId, reason: 'opponent_disconnected', remainingPlayer: remaining });
              delete matches[matchId];
            } else if (m.players.length === 0) {
              delete matches[matchId];
            }
          }
        });
      }
      console.log('socket disconnected', socket.id, 'player', socket.data && socket.data.playerId);
    } catch (err) {
      console.error('disconnect handler error', err);
    }
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('SeaStrike socket server listening on', PORT));
