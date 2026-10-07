// Realm Clash online server
// - Quick match queue (pairs players with the closest rating)
// - Private rooms with 5-letter codes
// - Relays live inputs, state snapshots and match events between the two players
// - Elo ranking + leaderboard (saved to ratings.json)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const DB_FILE = path.join(__dirname, 'ratings.json');
let ratings = {};
try { ratings = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { ratings = {}; }
let saveTimer = null;
function saveRatings() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DB_FILE, JSON.stringify(ratings)); } catch (e) {} }, 1000); }

function player(id, name) {
  if (!ratings[id]) ratings[id] = { name: name || 'Player', rating: 1000, wins: 0, losses: 0 };
  if (name) ratings[id].name = String(name).slice(0, 24);
  return ratings[id];
}
function leaderboard() {
  return Object.entries(ratings).map(([id, r]) => ({ name: r.name, rating: Math.round(r.rating), wins: r.wins, losses: r.losses }))
    .sort((a, b) => b.rating - a.rating).slice(0, 20);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/leaderboard') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(leaderboard())); return; }
  res.setHeader('Content-Type', 'text/plain'); res.end('Realm Clash server is running. Players online: ' + wss.clients.size);
});
const wss = new WebSocketServer({ server });

const queue = [];           // sockets waiting for quick match
const rooms = new Map();    // code -> { host, guest, ranked }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); } while (rooms.has(c)); return c; };
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function leaveQueue(ws) { const i = queue.indexOf(ws); if (i >= 0) queue.splice(i, 1); }
function closeRoom(ws, reason) {
  const room = ws.room; if (!room) return;
  const other = room.host === ws ? room.guest : room.host;
  if (other) { send(other, { t: 'opponent_left', reason }); other.room = null; }
  rooms.delete(room.code); ws.room = null;
}
function startRoom(room) {
  const h = room.host, g = room.guest, seed = Math.floor(Math.random() * 1e9);
  send(h, { t: 'matched', role: 'host', code: room.code, ranked: room.ranked, seed, opponent: { name: g.p.name, rating: Math.round(g.p.rating) } });
  send(g, { t: 'matched', role: 'guest', code: room.code, ranked: room.ranked, seed, opponent: { name: h.p.name, rating: Math.round(h.p.rating) } });
}
function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    let best = 0, bd = Infinity;
    queue.forEach((b, i) => { const d = Math.abs(a.p.rating - b.p.rating); if (d < bd) { bd = d; best = i; } });
    const b = queue.splice(best, 1)[0];
    const room = { code: newCode(), host: a, guest: b, ranked: true };
    rooms.set(room.code, room); a.room = room; b.room = room; startRoom(room);
  }
}
function applyResult(room, winnerRole) {
  if (!room.ranked || room.reported) return; room.reported = true;
  const W = winnerRole === 'host' ? room.host : room.guest, L = winnerRole === 'host' ? room.guest : room.host;
  if (!W || !L) return;
  const ea = 1 / (1 + Math.pow(10, (L.p.rating - W.p.rating) / 400)), K = 32;
  const delta = Math.round(K * (1 - ea));
  W.p.rating += delta; L.p.rating = Math.max(0, L.p.rating - delta); W.p.wins++; L.p.losses++; saveRatings();
  send(W, { t: 'rating', rating: Math.round(W.p.rating), delta: +delta, board: leaderboard() });
  send(L, { t: 'rating', rating: Math.round(L.p.rating), delta: -delta, board: leaderboard() });
}

wss.on('connection', ws => {
  ws.p = null; ws.room = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'hello') { ws.id = String(m.id || '').slice(0, 64) || ('anon' + Math.random()); ws.p = player(ws.id, m.name); send(ws, { t: 'welcome', rating: Math.round(ws.p.rating), wins: ws.p.wins, losses: ws.p.losses, board: leaderboard() }); return; }
    if (!ws.p) return;
    switch (m.t) {
      case 'queue': closeRoom(ws, 'left'); leaveQueue(ws); queue.push(ws); send(ws, { t: 'queued' }); tryMatch(); break;
      case 'cancel': leaveQueue(ws); closeRoom(ws, 'left'); send(ws, { t: 'cancelled' }); break;
      case 'create': { leaveQueue(ws); closeRoom(ws, 'left'); const room = { code: newCode(), host: ws, guest: null, ranked: false }; rooms.set(room.code, room); ws.room = room; send(ws, { t: 'room', code: room.code }); break; }
      case 'join': { const room = rooms.get(String(m.code || '').toUpperCase());
        if (!room || room.guest || room.host === ws) { send(ws, { t: 'error', msg: 'No open room with that code' }); break; }
        leaveQueue(ws); room.guest = ws; ws.room = room; startRoom(room); break; }
      case 'result': if (ws.room && ws.room.host === ws) applyResult(ws.room, m.winner); break;
      case 'leave': closeRoom(ws, 'left'); break;
      case 'board': send(ws, { t: 'board', board: leaderboard() }); break;
      default: // relay everything else (inputs, snapshots, events, fighter picks) to the opponent
        if (ws.room) { const other = ws.room.host === ws ? ws.room.guest : ws.room.host; if (other && other.readyState === 1) other.send(typeof raw === 'string' ? raw : raw.toString()); }
    }
  });
  ws.on('close', () => { leaveQueue(ws); closeRoom(ws, 'disconnected'); });
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 20000);
server.listen(PORT, () => console.log('Realm Clash server listening on ' + PORT));
