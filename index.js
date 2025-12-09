// server/index.js
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
 In-memory storage:
 matches: { matchId: {id, players: [playerId,...], placements: {playerId: [ships]}, shots: {playerId: Set(idx)}, turn, state } }
 sockets: map playerId -> socket.id
 searchQueue: simple array
*/
const matches = new Map();
const sockets = new Map();
const searchQueue = [];

/* helper funcs */
function cellIndex(x,y){ return y*10 + x; }
function coordsFromIndex(idx){ return { x: idx % 10, y: Math.floor(idx/10) }; }
function genId(prefix='m'){ return prefix + Math.random().toString(36).slice(2,9); }
function otherPlayer(match, playerId){ return match.players.find(p => String(p) !== String(playerId)); }
function normalizeId(id){ return String(id); }

/* HTTP health */
app.get('/health', (req,res)=> res.json({ ok:true, service:'SeaBattle Socket Server' }) );

/* Socket handlers */
io.on('connection', socket => {
  // identify - client sends its playerId and username
  socket.on('identify', (data) => {
    try {
      const pid = normalizeId(data.playerId || data.id || data.player);
      sockets.set(pid, socket.id);
      socket.playerId = pid;
      socket.emit('identified', { ok:true });
    } catch(e){ console.error(e); }
  });

  // create_match
  socket.on('create_match', (data) => {
    const playerId = normalizeId(data.playerId);
    const mId = genId('m');
    const match = {
      id: mId,
      players: [playerId],
      placements: {},
      shots: {}, // shots[playerId] = Set(idx)
      turn: playerId,
      state: 'waiting'
    };
    matches.set(mId, match);
    socket.join(mId);
    // reply to creator
    socket.emit('match_created', { matchId: mId });
    // notify if needed
  });

  // join_match
  socket.on('join_match', (data) => {
    const playerId = normalizeId(data.playerId);
    const matchId = data.matchId;
    const match = matches.get(matchId);
    if(!match){
      socket.emit('error', { error: 'match_not_found' });
      return;
    }
    if(match.players.includes(playerId)){
      socket.join(matchId);
      socket.emit('match_joined', { matchId });
      return;
    }
    if(match.players.length >= 2){
      socket.emit('error', { error: 'match_full' });
      return;
    }
    match.players.push(playerId);
    socket.join(matchId);
    // notify both players
    io.to(matchId).emit('match_joined', { matchId });
  });

 // find_match (FIFO, учитываем конкретные сокеты)
socket.on('find_match', (data) => {
  const playerId = normalizeId(data.playerId);

  // добавляем в очередь объект { playerId, socketId }
  const already = searchQueue.find(q => q.playerId === playerId);
  if (!already) {
    searchQueue.push({ playerId, socketId: socket.id });
  }

  // если есть хотя бы двое в очереди — создаём матч
  if (searchQueue.length >= 2) {
    const a = searchQueue.shift();
    const b = searchQueue.shift();

    const mid = genId('m');
    const match = {
      id: mid,
      players: [a.playerId, b.playerId],
      placements: {},
      shots: {},
      turn: a.playerId,   // первый в очереди ходит первым
      state: 'waiting'
    };
    matches.set(mid, match);

    // оба сокета в комнату матча
    if (a.socketId) io.sockets.sockets.get(a.socketId)?.join(mid);
    if (b.socketId) io.sockets.sockets.get(b.socketId)?.join(mid);

    // слать match_found прямо в конкретные сокеты
    if (a.socketId) io.to(a.socketId).emit('match_found', {
      matchId: mid,
      players: match.players,
      turn: match.turn
    });
    if (b.socketId) io.to(b.socketId).emit('match_found', {
      matchId: mid,
      players: match.players,
      turn: match.turn
    });
  } else {
    socket.emit('find_ack', { status: 'queued' });
  }
});

  // place_ships
  socket.on('place_ships', (data) => {
    const playerId = normalizeId(data.playerId);
    const matchId = data.matchId;
    const ships = data.ships || [];
    const match = matches.get(matchId);
    if(!match){ socket.emit('error', { error:'match_not_found' }); return; }
    match.placements[playerId] = ships;
    // initialize shots set
    match.shots[playerId] = match.shots[playerId] || new Set();
    // notify others
    io.to(matchId).emit('placement_update', { playerId });
    // if both ready -> start
    if(Object.keys(match.placements).length === 2 && match.state !== 'started'){
      match.state = 'started';
      match.turn = match.players[0]; // keep first player as starter
      io.to(matchId).emit('match_started', { matchId, turn: match.turn });
    }
  });

  // equip_skin
  socket.on('equip_skin', (data) => {
    // just ACK - client stores local as well
    socket.emit('profile', { equippedSkin: data.skinId, ownedSkins: [] });
  });

  // buy_skin (server-side mock buy)
  socket.on('buy_skin', (data) => {
    const playerId = normalizeId(data.playerId);
    const skinId = data.skinId;
    // In real: check payment provider / stars. Here: grant and respond ok.
    // keep it simple: respond purchase_result
    // Optionally you can build per-player owned list in memory.
    // We'll send purchase_result back to the socket that requested it.
    socket.emit('purchase_result', { ok: true, skinId, ownedSkins: [skinId] });
  });

  // shoot with ack
  socket.on('shoot', (data, ackFn) => {
    try {
      const playerId = normalizeId(data.playerId);
      const matchId = data.matchId;
      const x = Number(data.x);
      const y = Number(data.y);
      const match = matches.get(matchId);
      if(!match){
        if(typeof ackFn === 'function') ackFn(null, { ok:false, error:'match_not_found' });
        return;
      }
      // validate turn
      if(String(match.turn) !== String(playerId)){
        if(typeof ackFn === 'function') ackFn(null, { ok:false, error:'not_your_turn' });
        return;
      }
      // idx
      const idx = cellIndex(x,y);
      match.shots[playerId] = match.shots[playerId] || new Set();
      // prevent double shots
      if(match.shots[playerId].has(idx)){
        if(typeof ackFn === 'function') ackFn(null, { ok:false, error:'already_shot', existing:{ player: playerId, x, y, idx } });
        return;
      }
      // mark shot to prevent races
      match.shots[playerId].add(idx);

      // find opponent
      const oppId = otherPlayer(match, playerId);
      if(!oppId){
        if(typeof ackFn === 'function') ackFn(null, { ok:false, error:'no_opponent' });
        return;
      }
      // check opponent placements
      const oppShips = match.placements[oppId] || [];
      // convert ships to flat cell->ship mapping for check
      let hit = false, sunk = false, sunkShip = null;
      for(const ship of oppShips){
        const shipCells = ship.cells || [];
        // ship.cells may be numbers or {x,y} - assume numbers from client
        if(shipCells.includes(idx)){
          hit = true;
          // register this hit in match data: track opp hits? We'll store hits per match as hits[oppId] of idxs
          match.hits = match.hits || {};
          match.hits[oppId] = match.hits[oppId] || new Set();
          match.hits[oppId].add(idx);
          // check if all cells of that ship are hit (sunk)
          let allHit = shipCells.every(c => match.hits[oppId].has(c));
          if(allHit){
            sunk = true;
            sunkShip = { cells: shipCells, size: ship.size, orientation: ship.orientation, skinId: ship.skinId || null, owner: oppId };
          }
          break;
        }
      }

      // determine result
      const result = sunk ? 'sunk' : (hit ? 'hit' : 'miss');

      // set next turn (switch)
      const next = oppId;
      match.turn = next;

      // build payload
      const payload = {
        ok:true,
        result,
        x, y,
        shooter: playerId,
        newTurn: match.turn,
        finished: false,
        winner: null
      };

      // if sunk, check if all opponent ships sunk -> finish match
      if(sunk && sunkShip){
        // mark ship as sunk in match state (optional)
        match.sunk = match.sunk || {};
        match.sunk[oppId] = match.sunk[oppId] || [];
        match.sunk[oppId].push(sunkShip);
        // check if all ships of opp are sunk
        const oppShipsArr = oppShips;
        const oppTotalParts = oppShipsArr.reduce((s,sh)=> s + (sh.cells? sh.cells.length : (sh.size||0)), 0);
        const oppHitCount = (match.hits[oppId] && match.hits[oppId].size) || 0;
        if(oppHitCount >= oppTotalParts){
          // match finished - shooter wins
          match.state = 'finished';
          payload.finished = true;
          payload.winner = playerId;
          io.to(matchId).emit('match_finished', { matchId, winner: playerId });
        }
      }

      // ack to shooter immediately with result (so client doesn't hang)
      if(typeof ackFn === 'function') ackFn(null, { ok:true, result, newTurn: match.turn, finished: payload.finished || false, winner: payload.winner || null, sunkShip });

      // broadcast shot_result to both players (client also handles ack path)
      io.to(matchId).emit('shot_result', {
        matchId,
        shooter: playerId,
        x, y,
        result,
        newTurn: match.turn,
        finished: payload.finished || false,
        winner: payload.winner || null,
        sunkShip
      });

    } catch(e){
      console.error('shoot error', e);
      if(typeof ackFn === 'function') ackFn(null, { ok:false, error: 'server_error' });
    }
  });

  // leave
  socket.on('leave', (data) => {
    const playerId = normalizeId(data.playerId);
    const matchId = data.matchId;
    const match = matches.get(matchId);
    if(match){
      match.state = 'aborted';
      io.to(matchId).emit('player_left', { playerId });
      matches.delete(matchId);
    }
    sockets.delete(playerId);
    socket.leave(matchId);
  });

  socket.on('disconnect', () => {
    if(socket.playerId) sockets.delete(socket.playerId);
  });

});

server.listen(PORT, ()=> {
  console.log('Server listening on', PORT);
});
