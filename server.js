// Realm Clash online server
// - Quick match queue (pairs players with the closest rating)
// - Private rooms with 5-letter codes
// - Relays live inputs, state snapshots and match events between the two players
// - Elo ranking + leaderboard (saved to ratings.json)
// - Friend codes (+200 coins each) and gift chests between players
// - Player accounts: sign in with a username + password, progress saved on the server
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const crypto = require('crypto');
const DB_FILE = path.join(__dirname, 'ratings.json');
const ACC_FILE = path.join(__dirname, 'accounts.json');
// Optional permanent storage (free Upstash Redis). Without it, data lives in files that a free host may wipe on restart.
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
async function upCmd(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
let ratings = {}, accounts = {};
try { ratings = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { ratings = {}; }
try { accounts = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')); } catch (e) { accounts = {}; }
const loaded = (async () => {
  if (!UP_URL || !UP_TOKEN) { console.log('Storage: local files (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to keep data forever)'); return; }
  try {
    const r = await upCmd(['GET', 'rc_ratings']); if (r) ratings = JSON.parse(r);
    const a = await upCmd(['GET', 'rc_accounts']); if (a) accounts = JSON.parse(a);
    console.log('Storage: Upstash (' + Object.keys(accounts).length + ' accounts)');
  } catch (e) { console.log('Upstash load failed:', e.message); }
})();
function persist(key, file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj)); } catch (e) {}
  if (UP_URL && UP_TOKEN) upCmd(['SET', key, JSON.stringify(obj)]).catch(e => console.log('Upstash save failed:', e.message));
}
let saveTimer = null, accTimer = null;
function saveRatings() { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist('rc_ratings', DB_FILE, ratings), 1000); }
function saveAccounts() { clearTimeout(accTimer); accTimer = setTimeout(() => persist('rc_accounts', ACC_FILE, accounts), 1500); }

// ---- player accounts (username + password, progress stored on the server) ----
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const cleanUser = u => String(u || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20);
const signedIn = (ws, user, a) => { ws.acct = user; send(ws, { t: 'acct_ok', user: a.display || user, token: a.token, profile: a.profile || null }); };
function handleAccount(ws, m) {
  if (m.t === 'acct_reg' || m.t === 'acct_login') {
    const user = cleanUser(m.user), pass = String(m.pass || '');
    if (user.length < 3) return send(ws, { t: 'acct_err', msg: 'Username: at least 3 letters or numbers (a-z, 0-9).' });
    if (pass.length < 4 || pass.length > 100) return send(ws, { t: 'acct_err', msg: 'Password: at least 4 characters.' });
    const a = accounts[user];
    if (m.t === 'acct_reg') {
      if (a) return send(ws, { t: 'acct_err', msg: 'That username is taken. Try another one, or sign in.' });
      const salt = crypto.randomBytes(16).toString('hex');
      accounts[user] = { display: String(m.user).trim().slice(0, 20), salt, hash: hashPass(pass, salt), token: crypto.randomBytes(24).toString('hex'), profile: m.profile || null, created: Date.now() };
      saveAccounts(); return signedIn(ws, user, accounts[user]);
    }
    if (!a || hashPass(pass, a.salt) !== a.hash) return send(ws, { t: 'acct_err', msg: 'Wrong username or password.' });
    return signedIn(ws, user, a);
  }
  if (m.t === 'acct_tok') { const user = cleanUser(m.user), a = accounts[user];
    if (!a || !m.token || a.token !== m.token) return send(ws, { t: 'acct_err', msg: 'Please sign in again.', expired: true });
    return signedIn(ws, user, a); }
  if (m.t === 'acct_save') { const a = ws.acct && accounts[ws.acct]; if (!a) return;
    const txt = JSON.stringify(m.profile || null); if (txt.length > 300000) return;
    a.profile = m.profile; a.updated = Date.now(); saveAccounts(); send(ws, { t: 'acct_saved' }); return; }
  if (m.t === 'acct_out') { const a = ws.acct && accounts[ws.acct]; if (a && m.everywhere) { a.token = crypto.randomBytes(24).toString('hex'); saveAccounts(); } ws.acct = null; return; }
}

function player(id, name) {
  if (!ratings[id]) ratings[id] = { name: name || 'Player', rating: 1000, wins: 0, losses: 0 };
  if (name) ratings[id].name = String(name).slice(0, 24);
  return ratings[id];
}
function leaderboard() {
  return Object.entries(ratings).map(([id, r]) => ({ name: r.name, rating: Math.round(r.rating), wins: r.wins, losses: r.losses }))
    .sort((a, b) => b.rating - a.rating).slice(0, 20);
}

function findByCode(code) { code = String(code || '').toUpperCase(); if (!code) return null; return Object.keys(ratings).find(id => ratings[id].code === code) || null; }
function deliver(id, item) {
  for (const c of wss.clients) if (c.id === id && c.p && c.readyState === 1) { send(c, { t: 'inbox', items: [item] }); return; }
  const r = ratings[id]; if (!r) return; (r.pending = r.pending || []).push(item); if (r.pending.length > 50) r.pending.shift();
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
    if (typeof m.t === 'string' && m.t.startsWith('acct_')) { loaded.then(() => handleAccount(ws, m)); return; }
    if (m.t === 'hello') {
      ws.id = String(m.id || '').slice(0, 64) || ('anon' + Math.random()); ws.p = player(ws.id, m.name);
      if (m.code) ws.p.code = String(m.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const inbox = ws.p.pending || []; ws.p.pending = []; saveRatings();
      send(ws, { t: 'welcome', rating: Math.round(ws.p.rating), wins: ws.p.wins, losses: ws.p.losses, board: leaderboard(), inbox }); return; }
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
      case 'refer': { const owner = findByCode(m.code);
        if (!owner || owner === ws.id) { send(ws, { t: 'social_err', msg: 'No player has that code yet (they need to connect to this server once).' }); break; }
        if (ws.p.referredBy) { send(ws, { t: 'social_err', msg: 'You already used a friend code.' }); break; }
        ws.p.referredBy = owner; deliver(owner, { type: 'ref', from: ws.p.name }); saveRatings(); send(ws, { t: 'refer_ok' }); break; }
      case 'gift': { const owner = findByCode(m.code), item = String(m.item || '');
        if (!['wood', 'silver', 'gold'].includes(item)) { send(ws, { t: 'social_err', msg: 'Unknown gift.' }); break; }
        if (!owner || owner === ws.id) { send(ws, { t: 'social_err', msg: 'No player has that code yet (they need to connect to this server once).' }); break; }
        deliver(owner, { type: 'gift', item, from: ws.p.name }); saveRatings(); send(ws, { t: 'gift_ok' }); break; }
      default: // relay everything else (inputs, snapshots, events, fighter picks) to the opponent
        if (ws.room) { const other = ws.room.host === ws ? ws.room.guest : ws.room.host; if (other && other.readyState === 1) other.send(typeof raw === 'string' ? raw : raw.toString()); }
    }
  });
  ws.on('close', () => { leaveQueue(ws); closeRoom(ws, 'disconnected'); });
});

setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 20000);
server.listen(PORT, () => console.log('Realm Clash server listening on ' + PORT));
