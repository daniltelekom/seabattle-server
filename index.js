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
    methods: ['GET','POST'],
    transports: ['websocket','polling']
  }
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
     rematch: Set(playerId)
   }
 }
*/
const matches = new Map();
const sockets = new Map();
/** очередь поиска: [{ playerId, socketId }] */
const searchQueue = [];

/* helpers */
function cellIndex(x,y){ return y*10 + x; }
function genId(prefix='m'){ return prefix + Math.random().toString(36).slice(2,9); }
function normalizeId(id){ return String(id); }
function otherPlayer(match, playerId){ return match.players.find(p => String(p) !== String(playerId)); }
function removeFromQueue(playerId){
  const pid = normalizeId(playerId);
  const idx = searchQueue.findIndex(q => String(q.playerId) === pid);
  if(idx !== -1) searchQueue.splice(idx,1);
}

/* health */
app.get('/health', (req,res)=> res.json({ ok:true, service:'SeaStrike Socket Server' }) );

/* socket */
io.on('connection', socket => {
  // identify
  socket.on('identify', data => {
    try {
      const pid = normalizeId(data.playerId || data.id || data.player);
      sockets.set(pid, socket.id);
      socket.playerId = pid;
      socket.emit('identified', { ok:true });
    } catch(e){ console.error(e); }
  });

  // create_match (игра с другом)
  socket.on('create_match', data => {
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
      rematch: new Set()
    };
    matches.set(mId, match);
    socket.join(mId);
    socket.emit('match_created', { matchId: mId });
  });

  // join_match (по ID)
  socket.on('join_match', data => {
    const playerId = normalizeId(data.playerId);
    const matchId = data.matchId;
    const match = matches.get(matchId);
    if(!match){
      socket.emit('error', { error:'match_not_found' });
      return;
    }
    if(match.players.includes(playerId)){
      socket.join(matchId);
      socket.emit('match_joined', { matchId, players: match.players });
      return;
    }
    if(match.players.length >= 2){
      socket.emit('error', { error:'match_full' });
      return;
    }
    match.players.push(playerId);
    socket.join(matchId);
    io.to(matchId).emit('match_joined', { matchId, players: match.players });
  });

  // find_match (быстрый поиск)
  socket.on('find_match', data => {
    const playerId = normalizeId(data.playerId);
    const socketId = socket.id;

    // не дублируем игрока в очереди
    if(!searchQueue.find(q => q.playerId === playerId)){
      searchQueue.push({ playerId, socketId });
    }

    if(searchQueue.length >= 2){
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
        turn: a.playerId,      // первый в очереди ходит первым
        state: 'waiting',
        rematch: new Set()
      };
      matches.set(mId, match);

      // заводим оба сокета в комнату матча
      const sA = io.sockets.sockets.get(a.socketId);
      const sB = io.sockets.sockets.get(b.socketId);
      if(sA) sA.join(mId);
      if(sB) sB.join(mId);

      // шлём обоим match_found
      if(sA) sA.emit('match_found', { matchId: mId, players: match.players, turn: match.turn });
      if(sB) sB.emit('match_found', { matchId: mId, players: match.players, turn: match.turn });
    } else {
      socket.emit('find_ack', { status:'queued' });
    }
  });

  // place_ships
  socket.on('place_ships', data => {
    const playerId = normalizeId(data.playerId);
    const matchId = data.matchId;
    const ships   = data.ships || [];
    const match   = matches.get(matchId);
    if(!match){ socket.emit('error',{error:'match_not_found'}); return; }

    match.placements[playerId] = ships;
    match.shots[playerId] = match.shots[playerId] || new Set();
    match.hits[playerId]  = match.hits[playerId]  || new Set();

    io.to(matchId).emit('placement_update', { playerId });

    if(Object.keys(match.placements).length === 2 && match.state !== 'started'){
      match.state = 'started';
      match.turn  = match.players[0];
      io.to(matchId).emit('match_started', { matchId, turn: match.turn });
    }
  });

  // equip_skin (пока просто ACK)
  socket.on('equip_skin', data => {
    socket.emit('profile', { equippedSkin: data.skinId, ownedSkins: [] });
  });

  // buy_skin (мок)
  socket.on('buy_skin', data => {
    const skinId = data.skinId;
    socket.emit('purchase_result', { ok:true, skinId, ownedSkins:[skinId] });
  });

  // shoot
  socket.on('shoot', (data, ackFn) => {
    try{
      const playerId = normalizeId(data.playerId);
      const matchId  = data.matchId;
      const x = Number(data.x);
      const y = Number(data.y);
      const match = matches.get(matchId);
      if(!match){
        ackFn && ackFn(null,{ok:false,error:'match_not_found'});
        return;
      }
      if(match.state !== 'started'){
        ackFn && ackFn(null,{ok:false,error:'match_not_started'});
        return;
      }
      if(String(match.turn) !== String(playerId)){
        ackFn && ackFn(null,{ok:false,error:'not_your_turn'});
        return;
      }

      const idx = cellIndex(x,y);
      match.shots[playerId] = match.shots[playerId] || new Set();
      if(match.shots[playerId].has(idx)){
        ackFn && ackFn(null,{ok:false,error:'already_shot',existing:{player:playerId,x,y,idx}});
        return;
      }
      match.shots[playerId].add(idx);

      const oppId = otherPlayer(match, playerId);
      if(!oppId){
        ackFn && ackFn(null,{ok:false,error:'no_opponent'});
        return;
      }

      const oppShips = match.placements[oppId] || [];
      let hit = false, sunk = false, sunkShip = null;

      for(const ship of oppShips){
        const cells = ship.cells || [];
        if(cells.includes(idx)){
          hit = true;
          match.hits[oppId] = match.hits[oppId] || new Set();
          match.hits[oppId].add(idx);

          const allHit = cells.every(c => match.hits[oppId].has(c));
          if(allHit){
            sunk = true;
            sunkShip = {
              cells,
              size: ship.size,
              orientation: ship.orientation,
              skinId: ship.skinId || null,
              owner: oppId
            };
          }
          break;
        }
      }

      const result = sunk ? 'sunk' : (hit ? 'hit' : 'miss');
      let finished = false;
      let winner   = null;

      if(sunk && sunkShip){
        match.sunk[oppId] = match.sunk[oppId] || [];
        match.sunk[oppId].push(sunkShip);

        const totalParts = oppShips.reduce((s,sh)=> s + (sh.cells ? sh.cells.length : (sh.size||0)), 0);
        const hitCount   = (match.hits[oppId] && match.hits[oppId].size) || 0;
        if(totalParts > 0 && hitCount >= totalParts){
          finished = true;
          winner   = playerId;
          match.state = 'finished';
        }
      }

      if(!finished){
        match.turn = oppId;
      }

      const payload = {
        matchId,
        shooter: playerId,
        x, y,
        result,
        newTurn: finished ? null : match.turn,
        finished,
        winner,
        sunkShip
      };

      ackFn && ackFn(null,{ ok:true, ...payload });
      io.to(matchId).emit('shot_result', payload);

      if(finished){
        io.to(matchId).emit('match_finished', { matchId, winner });
      }

    } catch(e){
      console.error('shoot error', e);
      ackFn && ackFn(null,{ok:false,error:'server_error'});
    }
  });

  // request_rematch
  socket.on('request_rematch', data => {
    const playerId = normalizeId(data.playerId);
    const matchId  = data.matchId;
    const match    = matches.get(matchId);
    if(!match || match.state !== 'finished'){
      socket.emit('error',{error:'rematch_not_available'});
      return;
    }

    match.rematch = match.rematch || new Set();
    match.rematch.add(playerId);

    io.to(matchId).emit('rematch_vote', { matchId, playerId });

    if(match.rematch.size >= match.players.length){
      match.state      = 'waiting';
      match.placements = {};
      match.shots      = {};
      match.hits       = {};
      match.sunk       = {};
      match.rematch    = new Set();
      match.turn       = match.players[0];

      io.to(matchId).emit('rematch_start', { matchId, turn: match.turn });
    } else {
      socket.emit('rematch_pending', { matchId });
    }
  });

  // leave
  socket.on('leave', data => {
    const playerId = normalizeId(data.playerId);
    const matchId  = data.matchId;
    const match    = matches.get(matchId);

    removeFromQueue(playerId);

    if(match){
      match.state = 'aborted';
      io.to(matchId).emit('player_left', { playerId });
      matches.delete(matchId);
    }
    sockets.delete(playerId);
    socket.leave(matchId);
  });

  socket.on('disconnect', () => {
    if(socket.playerId){
      removeFromQueue(socket.playerId);
      sockets.delete(socket.playerId);
    }
  });
});

server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
