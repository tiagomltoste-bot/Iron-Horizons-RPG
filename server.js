// Iron Horizons: RPG — servidor do protótipo multijogador (sem dependências).
// Uso: node server.js   (a porta vem de PORT, por omissão 3000)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, MAX_PLAYERS = 20, NCLS = 3, CLSD = [{ hp: 120, cd: 1.1 }, { hp: 80, cd: .9 }, { hp: 90, cd: 1.9 }], PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.glb': 'model/gltf-binary' };

// Se existir a pasta "public", serve os ficheiros dela; caso contrário, serve apenas o index.html que está ao lado do servidor.
const HAS_PUB = fs.existsSync(PUB);
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/health') { res.writeHead(200); res.end('ok'); return; }
  let f = null;
  if (p === '/' || p === '/index.html') f = path.join(HAS_PUB ? PUB : __dirname, 'index.html');
  else if (HAS_PUB) { f = path.join(PUB, path.normalize(p)); if (!f.startsWith(PUB)) { res.writeHead(403); res.end(); return; } }
  if (!f) { res.writeHead(404); res.end('404'); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
});

/* ---------- WebSocket mínimo (RFC 6455) ---------- */
function frame(op, buf) {
  const n = buf.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, buf]);
}
const send = (c, o) => { if (!c.sock.destroyed) c.sock.write(frame(1, Buffer.from(JSON.stringify(o)))); };

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), frag: null, joined: false, seen: Date.now(), win: Date.now(), msgs: 0, lastAb: 0, lastChat: 0 };
  sock.on('data', d => { c.seen = Date.now(); c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 300000) { sock.destroy(); return; } parse(c); });
  sock.on('close', () => leave(c));
  sock.on('error', () => sock.destroy());
});

function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const fin = !!(b[0] & 0x80), op = b[0] & 15, masked = !!(b[1] & 0x80);
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (!masked || len > 65536) { c.sock.destroy(); return; }
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    if (op === 8) { c.sock.end(frame(8, Buffer.alloc(0))); return; }
    if (op === 9) { c.sock.write(frame(10, data)); continue; }
    if (op === 1 || op === 0) {
      c.frag = op === 1 ? [data] : (c.frag ? c.frag.concat([data]) : [data]);
      if (fin) { const s = Buffer.concat(c.frag).toString('utf8'); c.frag = null; handle(c, s); }
    }
  }
}

/* ---------- lógica do jogo ---------- */
let nextId = 1; const players = new Map();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), num = v => typeof v === 'number' && isFinite(v);
const cleanName = n => String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) || 'Aventureiro';
const clsOf = v => (Number.isInteger(v) && v >= 0 && v < NCLS) ? v : 0;
const pub = c => ({ id: c.id, name: c.name, cls: c.cls, x: c.x, z: c.z, r: c.r, m: c.m });
const bcast = (o, except) => { for (const p of players.values()) if (p !== except) send(p, o); };

function handle(c, s) {
  let m; try { m = JSON.parse(s); } catch { return; }
  if (!m || typeof m !== 'object') return;
  const now = Date.now();
  if (now - c.win > 1000) { c.win = now; c.msgs = 0; }
  if (++c.msgs > 60) return;
  if (m.t === 'join' && !c.joined) {
    if (players.size >= MAX_PLAYERS) { send(c, { t: 'full' }); c.sock.end(); return; }
    Object.assign(c, { joined: true, id: nextId++, name: cleanName(m.name), cls: clsOf(m.cls), x: 0, z: 10, r: Math.PI, m: 0, last: now, lv: 1, xp: 0 });
    c.mhp = CLSD[c.cls].hp; c.hp = c.mhp;
    players.set(c.id, c);
    send(c, { t: 'hello', id: c.id, players: [...players.values()].filter(p => p !== c).map(pub) });
    sendMe(c);
    bcast({ t: 'join', p: pub(c) }, c);
    console.log('+ ' + c.name + ' (' + players.size + ' online)');
    return;
  }
  if (!c.joined) return;
  if (m.t === 'pos' && num(m.x) && num(m.z) && num(m.r)) {
    const dt = Math.max(.05, (now - c.last) / 1000), maxd = 45 * dt + 1.5;
    const x = clamp(m.x, -50, 34.5), z = clamp(m.z, -44, 44);
    if (Math.hypot(x - c.x, z - c.z) > maxd) { send(c, { t: 'fix', x: c.x, z: c.z }); return; }
    Object.assign(c, { x, z, r: m.r, m: m.m ? 1 : 0, last: now });
    bcast({ t: 'pos', id: c.id, x, z, r: c.r, m: c.m }, c);
  } else if (m.t === 'cls') {
    c.cls = clsOf(m.cls); c.mhp = CLSD[c.cls].hp + 10 * (c.lv - 1); c.hp = Math.min(c.hp, c.mhp); sendMe(c);
    bcast({ t: 'cls', id: c.id, cls: c.cls }, c);
  } else if (m.t === 'ab') {
    useAb(c, now);
  } else if (m.t === 'chat' && typeof m.m === 'string') {
    if (now - c.lastChat < 500) return; c.lastChat = now;
    const txt = m.m.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    if (txt) bcast({ t: 'chat', id: c.id, name: c.name, m: txt });
  }
}

function leave(c) {
  if (!c.joined || !players.delete(c.id)) return;
  bcast({ t: 'leave', id: c.id });
  console.log('- ' + c.name + ' (' + players.size + ' online)');
}
setInterval(() => { const t = Date.now(); for (const c of players.values()) if (t - c.seen > 90000) c.sock.destroy(); }, 30000);


/* ---------- combate e inimigos (o servidor decide tudo) ---------- */
const safe = p => p.x > -23 && p.z > -18 && p.z < 16;   // Portavel e o cais: zona segura
const EK = [{ hp: 45, dmg: 7, speed: 3.4, aggro: 11, cd: 1100, xp: 15 }, { hp: 30, dmg: 5, speed: 2.8, aggro: 10, cd: 1000, xp: 10 }];
const SPAWNS = [[-32, -26], [-36, -12], [-31, 0], [-37, 12], [-32, 26], [-40, 36], [-18, -34], [-6, -38], [6, -33], [14, -37], [-24, -36], [0, -28]];
const enemies = SPAWNS.map((p, i) => ({ id: i, k: i % 2, sx: p[0], sz: p[1], x: p[0], z: p[1], r: 0, hp: EK[i % 2].hp, mhp: EK[i % 2].hp, target: null, nextAtk: 0, respawnAt: 0, hitters: new Set() }));
const sendMe = c => send(c, { t: 'me', hp: Math.round(c.hp), mhp: c.mhp, lv: c.lv, xp: c.xp, xpn: c.lv * 40 });
const sys = (c, m) => send(c, { t: 'sys', m });

function giveXp(c, n) {
  c.xp += n;
  while (c.xp >= c.lv * 40) { c.xp -= c.lv * 40; c.lv++; c.mhp += 10; c.hp = c.mhp; sys(c, 'Subiste para o nível ' + c.lv + '!'); }
  sendMe(c);
}
function dmgEnemy(e, d, c) {
  e.hp -= d; e.hitters.add(c); bcast({ t: 'eh', id: e.id, d });
  if (e.hp > 0) return;
  e.hp = 0; e.target = null; e.respawnAt = Date.now() + 20000;
  const xp = EK[e.k].xp, nome = e.k ? 'Goblin' : 'Lobo cinzento';
  for (const h of e.hitters) if (players.get(h.id) === h) { sys(h, 'Derrotaste um ' + nome + '! +' + xp + ' XP'); giveXp(h, xp); }
  e.hitters.clear();
}
function useAb(c, now) {
  if (now - c.lastAb < CLSD[c.cls].cd * 1000) return;
  c.lastAb = now; bcast({ t: 'ab', id: c.id }, c);
  const fx = Math.sin(c.r), fz = Math.cos(c.r), mult = 1 + .1 * (c.lv - 1); let hits = [];
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    const dx = e.x - c.x, dz = e.z - c.z, dist = Math.hypot(dx, dz), dot = dist > 0 ? (dx * fx + dz * fz) / dist : 1;
    if (c.cls === 0 && dist < 3 && dot > .2) hits.push([e, Math.round(18 * mult), dist]);
    else if (c.cls === 1 && dist < 15 && dot > .94) hits.push([e, Math.round(22 * mult), dist]);
    else if (c.cls === 2 && dist < 3.2 && dot > -.2) hits.push([e, Math.round(16 * mult), dist]);
  }
  if (c.cls === 1 && hits.length) hits = [hits.sort((a, b) => a[2] - b[2])[0]];
  hits.forEach(h => dmgEnemy(h[0], h[1], c));
}
function die(c) {
  c.hp = c.mhp; c.x = 0; c.z = 10; c.last = Date.now();
  send(c, { t: 'fix', x: 0, z: 10 }); sys(c, 'Foste derrotado e voltaste a Portavel.'); sendMe(c);
  bcast({ t: 'pos', id: c.id, x: 0, z: 10, r: c.r, m: 0 }, c);
}
let tick = 0;
setInterval(() => {
  const dt = .1, now = Date.now(); tick++;
  for (const e of enemies) {
    if (e.hp <= 0) { if (now >= e.respawnAt) { e.hp = e.mhp; e.x = e.sx; e.z = e.sz; e.target = null; } continue; }
    let t = e.target && players.get(e.target.id) === e.target && e.target.hp > 0 && !safe(e.target) ? e.target : null;
    if (t && Math.hypot(e.x - e.sx, e.z - e.sz) > 26) t = null;
    if (!t) { let best = EK[e.k].aggro; for (const p of players.values()) { if (p.hp <= 0 || safe(p)) continue; const d = Math.hypot(p.x - e.x, p.z - e.z); if (d < best) { best = d; t = p; } } }
    e.target = t;
    const tx = t ? t.x : e.sx, tz = t ? t.z : e.sz, sp = EK[e.k].speed * (t ? 1 : .8);
    const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz), stop = t ? 1.4 : .3;
    if (d > stop) { const m = Math.min(sp * dt, d - stop); e.x += dx / d * m; e.z += dz / d * m; e.r = Math.atan2(dx, dz); }
    if (!t && e.hp < e.mhp) e.hp = Math.min(e.mhp, e.hp + e.mhp * .01);
    if (t && d < 1.9 && now >= e.nextAtk) { e.nextAtk = now + EK[e.k].cd; t.hp -= EK[e.k].dmg; bcast({ t: 'ea', id: e.id }); if (t.hp <= 0) die(t); else sendMe(t); }
  }
  if (tick % 5 === 0) for (const p of players.values()) if (safe(p) && p.hp < p.mhp) { p.hp = Math.min(p.mhp, p.hp + 2.5); sendMe(p); }
  if (players.size) bcast({ t: 'en', e: enemies.map(e => [e.id, e.k, +e.x.toFixed(2), +e.z.toFixed(2), +e.r.toFixed(2), Math.round(e.hp), e.mhp]) });
}, 100);

server.listen(PORT, () => console.log('Iron Horizons a correr em http://localhost:' + PORT));
