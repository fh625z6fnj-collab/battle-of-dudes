// Dude Battle Arena — lobby + relay server (no dependencies).
//   node server.js        ->  http://localhost:3000
// Adds on top of the old relay: persistent squad lobby, best-of rounds for 1v1,
// armed-by-server round scoring, peer-gone handling, and a friends list with invites.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map(), socks = new Set(), friends = new Map(), byTag = new Map();

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  } else if (u === '/health') { res.setHeader('Content-Type', 'text/plain'); res.end('ok'); }
  else { res.writeHead(404); res.end('not found'); }
});

function frame(str) {
  const b = Buffer.from(str); let h;
  if (b.length < 126) h = Buffer.from([0x81, b.length]);
  else if (b.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(b.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); }
  return Buffer.concat([h, b]);
}
const send = (s, o) => { if (s && !s.destroyed && s.writable) s.write(frame(JSON.stringify(o))); };

function parse(s) {
  const b = s.buf; if (b.length < 2) return null;
  const op = b[0] & 15, fin = b[0] & 128, masked = b[1] & 128;
  let len = b[1] & 127, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  if (len > 1 << 20) { s.destroy(); return null; }
  const need = off + (masked ? 4 : 0) + len; if (b.length < need) return null;
  const mask = masked ? b.slice(off, off + 4) : null; if (masked) off += 4;
  const p = Buffer.from(b.slice(off, off + len));
  if (mask) for (let i = 0; i < len; i++) p[i] ^= mask[i & 3];
  s.buf = b.slice(need);
  return { op, fin, p };
}

const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function mkCode() { let c; do { c = ''; for (let i = 0; i < 4; i++) c += CH[crypto.randomInt(CH.length)]; } while (rooms.has(c)); return c; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v | 0));
const TAG_OK = t => typeof t === 'string' && (t = t.trim().replace(/\s+/g, ' ')).length >= 2 && t.length <= 24 && t;
function cleanTag(t) { t = String(t || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24); return t || null; }

// friend registry: tag -> Set(friend tags); byTag: tag -> live socket
const fset = t => { if (!friends.has(t)) friends.set(t, new Set()); return friends.get(t); };
const tagLive = t => { const s = byTag.get(t); return s && !s.destroyed && s.room !== undefined ? s : null; };

function friendRoom(tag) { for (const r of rooms.values()) { if (r.h && r.h.tag === tag) return r; if (r.g && r.g.tag === tag) return r; } return null; }
function friendList(tag) { const out = []; for (const f of fset(tag)) { const s = tagLive(f); out.push({ tag: f, online: !!s, lobby: !!s && !!s.room }); } return out; }

function newRoom(s, m) {
  const r = { code: mkCode(), mode: m.mode === '1v1' ? '1v1' : 'coop', df: clamp(m.df, 0, 2), mp: clamp(m.mp, 0, 3), rounds: clamp(m.rounds, 1, 7), h: s, g: null, sc: { h: 0, g: 0 }, rnd: 0, lock: 0, born: Date.now() };
  rooms.set(r.code, r); return r;
}
function startMatch(r) {
  r.lock = 0;
  const seed = crypto.randomInt(1, 2 ** 31);
  const base = { t: 'start', mode: r.mode, df: r.df, mp: r.mp, seed, rnd: r.rnd + 1, rounds: r.mode == '1v1' ? r.rounds : 0 };
  if (r.h) send(r.h, { ...base, role: 'host' });
  if (r.g) send(r.g, { ...base, role: 'guest' });
}
function broadcast(r, m) { if (r.h) send(r.h, m); if (r.g) send(r.g, m); }
function peerOf(s) { const r = s.room; if (!r) return null; return r.h === s ? r.g : r.h; }

// socket leaves: notify peer, keep room alive only if the host is still connected
function dropSock(s, explicit) {
  const r = s.room; if (!r) return; s.room = null;
  if (r.h === s) { r.h = null; if (r.g) { send(r.g, explicit ? { t: 'left' } : { t: 'pg' }); r.g.room = null; rooms.delete(r.code); } else rooms.delete(r.code); }
  else { r.g = null; if (r.h) send(r.h, explicit ? { t: 'left' } : { t: 'pg' }); } // guest: room stays for a rejoin
}

function onMsg(s, m) {
  if (m.t === 'who') {
    const tag = cleanTag(m.tag); if (!tag) return;
    s.tag = tag; byTag.set(tag, s);
    send(s, { t: 'friends', list: friendList(tag) });
  } else if (m.t === 'create') {
    dropSock(s, false);
    const r = newRoom(s, m); s.room = r; s.role = 'host';
    send(s, { t: 'created', code: r.code });
  } else if (m.t === 'join') {
    const r = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!r || r.h === s) return send(s, { t: 'err', msg: 'No match found with that code' });
    if (r.g && r.g !== s) return send(s, { t: 'err', msg: 'That match is already full' });
    const rejoin = !r.g && r.rnd > 0;
    dropSock(s, false);
    r.g = s; s.room = r; s.role = 'guest';
    broadcast(r, { t: 'joined', tag: s.tag, host: r.h ? r.h.tag : null });
    if (rejoin) startMatch(r); // peer dropped mid-lifetime: restart the match on rejoin
  } else if (m.t === 'tolobby') {
    const r = s.room; if (!r) return;
    r.rnd = 0; r.lock = 0; r.sc = { h: 0, g: 0 };
    broadcast(r, { t: 'tolobby' });
  } else if (m.t === 'newmatch') {
    const r = s.room; if (!r) return;
    r.mode = m.mode === '1v1' ? '1v1' : 'coop';
    r.df = clamp(m.df, 0, 2); r.mp = clamp(m.mp, 0, 3); r.rounds = clamp(m.rounds, 1, 7);
    r.sc = { h: 0, g: 0 };
    startMatch(r);
  } else if (m.t === 'bye') {
    dropSock(s, true);
  } else if (m.t === 'r' && s.room) {
    const r = s.room;
    if (m.d && m.d.t === 'die' && r.mode === '1v1') {
      if (r.lock) return;                     // round already decided (double-KO edge)
      r.lock = 1;
      const w = s === r.h ? 'g' : 'h';
      r.sc[w] = (r.sc[w] || 0) + 1;
      const fin = r.sc[w] >= (r.rounds || 3) ? w : 0;
      broadcast(r, { t: 'r', d: { t: 'rnd', w, n: r.rnd + 1, h: r.sc.h, g: r.sc.g, fin } });
      return;
    }
    const o = peerOf(s);
    if (o) send(o, { t: 'r', d: m.d });
  } else if (m.t === 'friends') {
    if (s.tag) send(s, { t: 'friends', list: friendList(s.tag) });
  } else if (m.t === 'addfriend') {
    const other = cleanTag(m.tag);
    if (!s.tag || !other) return send(s, { t: 'err', msg: 'Invalid friend name' });
    if (other === s.tag) return send(s, { t: 'err', msg: "You can't add yourself" });
    fset(s.tag).add(other); fset(other).add(s.tag);
    const t = tagLive(other);
    if (t) send(t, { t: 'fradd', tag: s.tag });
    send(s, { t: 'friends', list: friendList(s.tag) });
  } else if (m.t === 'rmfriend') {
    const other = cleanTag(m.tag);
    if (s.tag && other) { fset(s.tag).delete(other); fset(other).delete(s.tag); send(s, { t: 'friends', list: friendList(s.tag) }); }
  } else if (m.t === 'invite') {
    const code = String(m.code || '').toUpperCase();
    const r = rooms.get(code);
    if (!r) return send(s, { t: 'err', msg: 'Open a lobby first, then invite' });
    const other = tagLive(cleanTag(m.to));
    if (!other) return send(s, { t: 'err', msg: 'Friend is offline' });
    send(other, { t: 'invited', from: cleanTag(s.tag), code });
  }
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.room = null; sock.tag = null; sock.buf = Buffer.alloc(0); sock.setKeepAlive(true, 30000); sock.setNoDelay(true);
  socks.add(sock); let n = 0, t0 = Date.now();
  sock.on('data', d => {
    sock.buf = Buffer.concat([sock.buf, d]);
    if (sock.buf.length > 1 << 20) return sock.destroy();
    let f;
    while ((f = parse(sock))) {
      if (f.op === 8) { socks.delete(sock); dropSock(sock, false); return sock.end(Buffer.from([0x88, 0])); }
      if (f.op === 9) { sock.write(Buffer.from([0x8a, 0])); continue; }
      if (f.op !== 1 || !f.fin) continue;
      if (Date.now() - t0 > 1000) { t0 = Date.now(); n = 0; }
      if (++n > 400) continue;
      let m; try { m = JSON.parse(f.p.toString()); } catch (e) { continue; }
      if (m && typeof m === 'object') onMsg(sock, m);
    }
  });
  const gone = () => {
    socks.delete(sock);
    if (sock.tag && byTag.get(sock.tag) === sock) byTag.delete(sock.tag);
    dropSock(sock, false);
  };
  sock.on('close', gone); sock.on('error', () => sock.destroy());
});
setInterval(() => socks.forEach(s => s.writable && s.write(Buffer.from([0x89, 0]))), 25000);
setInterval(() => { // sweep abandoned guest-less rooms
  const now = Date.now();
  for (const [c, r] of rooms) if (!r.g && now - (r.touched || r.born) > 300000) rooms.delete(c);
}, 30000);
server.listen(PORT, () => console.log('Dude Battle Arena server (lobby + friends) on http://localhost:' + PORT));
