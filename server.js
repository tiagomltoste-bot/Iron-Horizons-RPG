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
  const c = { sock, buf: Buffer.alloc(0), frag: null, joined: false, seen: Date.now(), win: Date.now(), msgs: 0, lastAb: 0, lastChat: 0, tries: 0 };
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
  if (m.t === 'auth' && !c.joined && !c.authing) { authenticate(c, m); return; }
  if (!c.joined) return;
  if (m.t === 'pos' && num(m.x) && num(m.z) && num(m.r)) {
    const dt = Math.max(.05, (now - c.last) / 1000), maxd = 45 * dt + 1.5;
    const x = clamp(m.x, -50, 34.5), z = clamp(m.z, -44, 44);
    if (Math.hypot(x - c.x, z - c.z) > maxd) { send(c, { t: 'fix', x: c.x, z: c.z }); return; }
    Object.assign(c, { x, z, r: m.r, m: m.m ? 1 : 0, last: now });
    bcast({ t: 'pos', id: c.id, x, z, r: c.r, m: c.m }, c);
  } else if (m.t === 'cls') {
    c.cls = clsOf(m.cls); c.mhp = CLSD[c.cls].hp + 10 * (c.lv - 1); c.hp = Math.min(c.hp, c.mhp); sendMe(c); c.dirty = true; saveAcc(c);
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
  if (byKey.get(c.key) === c) byKey.delete(c.key);
  saveAcc(c);
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
  c.dirty = true; let up = false;
  while (c.xp >= c.lv * 40) { c.xp -= c.lv * 40; c.lv++; c.mhp += 10; c.hp = c.mhp; up = true; sys(c, 'Subiste para o nível ' + c.lv + '!'); }
  if (up) saveAcc(c);
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
    else if (c.cls === 2 && dist < 3.2 && dot > -.2) hits.push([e, Math.round(16 * mult), dist]);
  }
  if (c.cls === 1) spawnOrb(c, Math.round(22 * mult), fx, fz);
  hits.forEach(h => dmgEnemy(h[0], h[1], c));
}
const orbs = []; let nextOrb = 1;
function spawnOrb(c, dmg, fx, fz) {   // o dano só acontece quando a bola chega ao inimigo
  const o = { id: nextOrb++, owner: c, x: c.x + fx * .8, z: c.z + fz * .8, vx: fx * 14, vz: fz * 14, life: 1.3, dmg };
  orbs.push(o); bcast({ t: 'pj', id: o.id, x: +o.x.toFixed(2), z: +o.z.toFixed(2), vx: +o.vx.toFixed(2), vz: +o.vz.toFixed(2), life: o.life });
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
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i], nx = o.x + o.vx * dt, nz = o.z + o.vz * dt, sx = nx - o.x, sz = nz - o.z, l2 = sx * sx + sz * sz;
    let hit = null, bt = 2;
    for (const e of enemies) {
      if (e.hp <= 0) continue;
      const t = l2 ? Math.max(0, Math.min(1, ((e.x - o.x) * sx + (e.z - o.z) * sz) / l2)) : 0;
      if (Math.hypot(o.x + sx * t - e.x, o.z + sz * t - e.z) < .9 && t < bt) { bt = t; hit = e; }
    }
    if (hit) { orbs.splice(i, 1); bcast({ t: 'pk', id: o.id, x: +(o.x + sx * bt).toFixed(2), z: +(o.z + sz * bt).toFixed(2) }); dmgEnemy(hit, o.dmg, o.owner); continue; }
    o.x = nx; o.z = nz; o.life -= dt;
    if (o.life <= 0) { orbs.splice(i, 1); bcast({ t: 'pk', id: o.id, x: +o.x.toFixed(2), z: +o.z.toFixed(2) }); }
  }
  if (tick % 5 === 0) for (const p of players.values()) if (safe(p) && p.hp < p.mhp) { p.hp = Math.min(p.mhp, p.hp + 2.5); sendMe(p); }
  if (players.size) bcast({ t: 'en', e: enemies.map(e => [e.id, e.k, +e.x.toFixed(2), +e.z.toFixed(2), +e.r.toFixed(2), Math.round(e.hp), e.mhp]) });
}, 100);

/* ---------- contas e progresso guardado ---------- */
// Com UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN definidos, as contas ficam numa base de dados online.
// Sem elas, ficam no ficheiro accounts.json (serve para testar no teu computador; na Render perde-se ao reiniciar).
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, ''), UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DATA_FILE = path.join(__dirname, 'accounts.json'); let mem = null;
const loadMem = () => { if (!mem) { try { mem = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { mem = {}; } } return mem; };
async function upstash(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('base de dados: ' + r.status); return (await r.json()).result;
}
async function dbGet(k) { if (UP_URL) { const v = await upstash(['GET', k]); return v ? JSON.parse(v) : null; } return loadMem()[k] || null; }
async function dbSet(k, v) { if (UP_URL) { await upstash(['SET', k, JSON.stringify(v)]); return; } loadMem()[k] = v; fs.writeFile(DATA_FILE, JSON.stringify(mem), () => {}); }
async function dbCreate(k, v) { if (UP_URL) return (await upstash(['SET', k, JSON.stringify(v), 'NX'])) === 'OK'; if (loadMem()[k]) return false; await dbSet(k, v); return true; }
const scrypt = (p, salt) => new Promise((res, rej) => crypto.scrypt(p, salt, 32, (e, k) => e ? rej(e) : res(k)));
const byKey = new Map(), failures = new Map(); let regs = [];
const aerr = (c, m) => send(c, { t: 'autherr', m });

function saveAcc(c) {
  if (!c.acc || !c.dirty) return Promise.resolve();
  c.dirty = false; Object.assign(c.acc, { cls: c.cls, lv: c.lv, xp: c.xp, seen: Date.now() });
  return dbSet(c.key, c.acc).catch(e => { c.dirty = true; console.log('erro ao guardar:', e.message); });
}
async function authenticate(c, m) {
  c.authing = true;
  try {
    if (++c.tries > 8) { aerr(c, 'Demasiadas tentativas. Recarrega a página.'); c.sock.end(); return; }
    const name = String(m.name || '').trim(), pass = String(m.pass || ''), now = Date.now();
    if (!/^\w{3,16}$/.test(name) || pass.length < 6 || pass.length > 64) return aerr(c, 'Nome (3 a 16 letras, números ou _) ou palavra-passe (mínimo 6) inválidos.');
    const key = 'acc:' + name.toLowerCase(), f = failures.get(key);
    if (f && f.until > now) return aerr(c, 'Muitas tentativas. Espera um minuto.');
    let acc;
    if (m.mode === 'register') {
      regs = regs.filter(t => now - t < 600000);
      if (regs.length >= 20) return aerr(c, 'Demasiados registos de seguida. Tenta daqui a uns minutos.');
      regs.push(now);
      const salt = crypto.randomBytes(16);
      acc = { name, s: salt.toString('hex'), h: (await scrypt(pass, salt)).toString('hex'), created: now, cls: clsOf(m.cls), lv: 1, xp: 0 };
      if (!(await dbCreate(key, acc))) return aerr(c, 'Esse nome já existe. Escolhe outro ou entra com a tua conta.');
    } else {
      acc = await dbGet(key);
      const ok = acc && crypto.timingSafeEqual(await scrypt(pass, Buffer.from(acc.s, 'hex')), Buffer.from(acc.h, 'hex'));
      if (!ok) {
        const fl = failures.get(key) || { n: 0, until: 0 }; if (++fl.n >= 5) { fl.n = 0; fl.until = now + 60000; } failures.set(key, fl);
        return aerr(c, 'Nome ou palavra-passe errados.');
      }
      failures.delete(key);
    }
    if (c.sock.destroyed) return;
    if (players.size >= MAX_PLAYERS) { send(c, { t: 'full' }); c.sock.end(); return; }
    if (byKey.has(key)) return aerr(c, 'Esta conta já está ligada noutro sítio.');
    Object.assign(c, { joined: true, id: nextId++, key, acc, name: acc.name, cls: clsOf(acc.cls), x: 0, z: 10, r: Math.PI, m: 0, last: now, lv: acc.lv || 1, xp: acc.xp || 0, dirty: false });
    c.mhp = CLSD[c.cls].hp + 10 * (c.lv - 1); c.hp = c.mhp;
    players.set(c.id, c); byKey.set(key, c);
    send(c, { t: 'hello', id: c.id, name: c.name, cls: c.cls, players: [...players.values()].filter(p => p !== c).map(pub) });
    sendMe(c); bcast({ t: 'join', p: pub(c) }, c);
    console.log('+ ' + c.name + ' (' + players.size + ' online)');
  } catch (e) { console.log('erro de autenticação:', e.message); aerr(c, 'Erro no servidor. Tenta de novo.'); }
  finally { c.authing = false; }
}
setInterval(() => { for (const c of players.values()) saveAcc(c); }, 300000);
process.on('SIGTERM', async () => { await Promise.all([...players.values()].map(saveAcc)); process.exit(0); });
console.log(UP_URL ? 'Contas: base de dados online (Upstash).' : 'Contas: ficheiro accounts.json (sem base de dados online configurada).');

server.listen(PORT, () => console.log('Iron Horizons a correr em http://localhost:' + PORT));
