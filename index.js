// index.js — SeaStrike realtime backend (Socket.IO, in-memory)
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
function coordToIdx(x,y){ return y*10+x; }

function evaluateShot(match, shooterId, x, y) {
  const idx = coordToIdx(x,y);
  const oppId = match.players.find(p => p !== shooterId);
  if (!oppId) return { error:'no_opponent' };
  const oppShips = match.placements[oppId] || [];
  const already = match.moves.find(m => m.idx === idx);
  if (already) return { error:'already_shot', existing: already };
  let result = 'miss', sunkShipId = null;
  for (const ship of oppShips) {
    if (ship.cells.includes(idx)) {
      result = 'hit';
      const hitIdxs = new Set(match.moves.filter(m=>m.result!=='miss' && ship.cells.includes(m.idx)).map(m=>m.idx));
      hitIdxs.add(idx);
      if (ship.cells.every(c => hitIdxs.has(c))) {
        result = 'sunk';
        sunkShipId = ship.id;
      }
      break;
    }
  }
  match.moves.push({ player: shooterId, x, y, idx, result, time: Date.now() });
  match.turn = oppId;
  let finished=false,winner=null;
  const allHitIdxs = new Set(match.moves.filter(m=>m.result!=='miss').map(m=>m.idx));
  if (match.placements[oppId] && match.placements[oppId].every(ship => ship.cells.every(c => allHitIdxs.has(c)))) {
    finished = true;
    winner = shooterId;
    match.state = 'finished';
    match.result = { winner, finishedAt: Date.now() };
    // update elo and stars
    const loser = oppId;
    const Ra = players[winner].rating || 1000;
    const Rb = players[loser].rating || 1000;
    players[winner].rating = elo(Ra, Rb, 1);
    players[loser].rating = elo(Rb, Ra, 0);
    players[winner].stars = (players[winner].stars||0) + 10;
  }
  return { result, sunkShipId, finished, winner, newTurn: match.turn };
}

// Express simple endpoints (health + optional debug)
app.get('/', (req,res)=> res.send('SeaStrike Socket.IO backend'));
app.get('/health',(req,res)=>res.json({status:'ok'}));
app.get('/player/:id',(req,res)=>{
  const p = players[String(req.params.id)];
  if(!p) return res.status(404).json({error:'no_player'});
  return res.json(p);
});

// Socket.IO logic
io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // client must emit 'identify' asap with { playerId, username }
  socket.on('identify', ({playerId, username})=>{
    if(!playerId) return;
    makePlayer(String(playerId), username||('p'+playerId));
    sockets[String(playerId)] = socket.id;
    socket.data.playerId = String(playerId);
    console.log('player identified', playerId);
    // optionally join player's personal room
    socket.join('p-'+String(playerId));
    socket.emit('identified', { ok:true, player: players[String(playerId)] });
  });

  // create match (host)
  socket.on('create_match', ({playerId})=>{
    if(!playerId) return socket.emit('error',{error:'no_playerId'});
    const id = 'm' + shortid.generate();
    matches[id] = { id, players:[String(playerId)], placements:{}, moves:[], turn:null, state:'waiting', createdAt: Date.now() };
    socket.join(id);
    socket.emit('match_created', { matchId:id });
    console.log('match created', id, 'by', playerId);
  });

  // join match by id
  socket.on('join_match', ({matchId, playerId})=>{
    const m = matches[matchId];
    if(!m) return socket.emit('error',{error:'no_match'});
    if(m.players.length>=2) return socket.emit('error',{error:'full'});
    m.players.push(String(playerId));
    // join sockets of both players into match room (if present)
    socket.join(matchId);
    const otherSocketId = sockets[m.players[0]];
    if(otherSocketId) io.sockets.sockets.get(otherSocketId)?.join(matchId);
    io.to(matchId).emit('match_joined', { matchId, players: m.players });
    console.log('player', playerId, 'joined match', matchId);
  });

  // find / matchmaking (simple queue)
  socket.on('find_match', ({playerId})=>{
    if(!playerId) return socket.emit('error',{error:'no_playerId'});
    if(queue.includes(String(playerId))) return socket.emit('searching',{status:'searching'});
    if(queue.length>0){
      const opp = queue.shift();
      const id = 'm' + shortid.generate();
      matches[id] = { id, players:[String(playerId), String(opp)], placements:{}, moves:[], turn:String(playerId), state:'waiting', createdAt: Date.now() };
      // join both sockets if connected
      const s1 = sockets[String(playerId)]; const s2 = sockets[String(opp)];
      if(s1) io.sockets.sockets.get(s1)?.join(id);
      if(s2) io.sockets.sockets.get(s2)?.join(id);
      io.to(id).emit('match_found', { matchId:id, players: matches[id].players });
      console.log('match found', id, matches[id].players);
    } else {
      queue.push(String(playerId));
      socket.emit('searching',{status:'searching'});
    }
  });

  // place ships
  socket.on('place_ships', ({matchId, playerId, ships})=>{
    const m = matches[matchId];
    if(!m) return socket.emit('error',{error:'no_match'});
    m.placements[String(playerId)] = ships;
    m.ready = m.ready || {};
    m.ready[String(playerId)] = true;
    io.to(matchId).emit('placement_update', { playerId, ships });
    if(m.players.length===2 && m.ready[m.players[0]] && m.ready[m.players[1]]){
      m.state='started';
      m.turn = m.players[0];
      io.to(matchId).emit('match_started', { matchId, turn: m.turn });
    }
  });

  // shoot
  socket.on('shoot', ({matchId, playerId, x, y})=>{
    const m = matches[matchId];
    if(!m) return socket.emit('error',{error:'no_match'});
    if(m.state!=='started') return socket.emit('error',{error:'not_started'});
    if(String(m.turn) !== String(playerId)) return socket.emit('error',{error:'not_your_turn'});
    const ev = evaluateShot(m, String(playerId), Number(x), Number(y));
    if(ev.error) return socket.emit('error', ev);
    // broadcast shot result to room
    io.to(matchId).emit('shot_result', { matchId, shooter: playerId, x, y, result: ev.result, sunkShipId: ev.sunkShipId, finished: ev.finished, winner: ev.winner, newTurn: ev.newTurn });
    // if match finished, send match result
    if(ev.finished){
      io.to(matchId).emit('match_finished', { matchId, winner: ev.winner, result: m.result });
    }
  });

  // player leaves / disconnect
  socket.on('leave', ({playerId, matchId})=>{
    if(playerId) {
      const idx = queue.indexOf(String(playerId));
      if(idx !== -1) queue.splice(idx,1);
    }
    if(matchId){
      const m = matches[matchId];
      if(m){
        m.players = m.players.filter(p=>p!==String(playerId));
        io.to(matchId).emit('player_left', { playerId, matchId });
        if(m.players.length===0) delete matches[matchId];
      }
    }
    if(playerId) delete sockets[String(playerId)];
  });

  socket.on('disconnect', ()=> {
    const pid = socket.data.playerId;
    if(pid) {
      delete sockets[pid];
      const idx = queue.indexOf(pid);
      if(idx!==-1) queue.splice(idx,1);
    }
    console.log('socket disconnect', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('SeaStrike socket server listening on', PORT));
