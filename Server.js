// سرور حساب‌های ایران سیتی — بدون وابستگی. اجرا: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB = process.env.DB_FILE || path.join(__dirname, 'data.json');
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'sajjadrip4@gmail.com').toLowerCase();

let db = { users: {}, tokens: {} };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
db.users = db.users || {}; db.tokens = db.tokens || {};
db.banned = db.banned || {};          // ایمیل‌های بن‌شده
db.bannedNames = db.bannedNames || {}; // اسم مهمان‌های بن‌شده
db.reports = db.reports || [];        // گزارش‌های بازیکن‌ها
let dirty = false;
const save = () => { dirty = true; };
function flush() { if (!dirty) return; dirty = false; fs.writeFileSync(DB + '.tmp', JSON.stringify(db)); fs.renameSync(DB + '.tmp', DB); }
setInterval(flush, 2000);
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { flush(); process.exit(0); }));

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' }); res.end(JSON.stringify(obj)); };
const fail = (res, code, msg) => send(res, code, { error: msg });
function body(req) { return new Promise((ok, no) => { let s = ''; req.on('data', d => { s += d; if (s.length > 10000) { no(new Error('big')); req.destroy(); } }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { no(e); } }); }); }
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const okEmail = e => typeof e === 'string' && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const BAD = ['کیر', 'کص', 'کون', 'جنده', 'گایید', 'حرومزاده', 'کثافت', 'عوضی', 'بیشرف', 'لعنتی'];
const cleanName = n => { n = String(n || '').trim(); if (n.length < 2 || n.length > 14) return null; const s = n.replace(/[‌‏\s._\-*]/g, ''); return BAD.some(b => s.includes(b)) ? null : n; };
const clamp = (v, a, b, d) => (typeof v === 'number' && isFinite(v)) ? Math.max(a, Math.min(b, v)) : d;
const lower = s => String(s || '').trim().toLowerCase();
const profile = u => ({ name: u.name, m: u.m, h: u.h, job: u.job, police: !!u.police });
function newToken(email) { const t = crypto.randomBytes(32).toString('hex'); db.tokens[t] = email; save(); return t; }
function auth(req) { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const e = db.tokens[t]; return e && db.users[e] && !db.banned[e] ? { email: e, user: db.users[e], token: t } : null; }

const hits = new Map();
function limited(req) { const ip = req.socket.remoteAddress, n = Date.now(), h = hits.get(ip) || { c: 0, t: n }; if (n - h.t > 60000) { h.c = 0; h.t = n; } h.c++; hits.set(ip, h); return h.c > 20; }

const routes = {
  '/api/register': async (req, res, b) => {
    const email = String(b.email || '').trim().toLowerCase(), name = cleanName(b.name);
    if (!okEmail(email)) return fail(res, 400, 'ایمیل معتبر نیست');
    if (typeof b.password !== 'string' || b.password.length < 6 || b.password.length > 100) return fail(res, 400, 'رمز حداقل ۶ حرف باشه');
    if (!name) return fail(res, 400, 'اسم معتبر نیست');
    if (db.users[email]) return fail(res, 409, 'این ایمیل قبلاً ثبت شده');
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[email] = { salt, ph: hashPw(b.password, salt), name, m: 200, h: 100, job: 'citizen' };
    send(res, 200, { token: newToken(email), profile: profile(db.users[email]) });
  },
  '/api/login': async (req, res, b) => {
    const email = String(b.email || '').trim().toLowerCase(), u = db.users[email];
    if (!u || typeof b.password !== 'string' || !same(u.ph, hashPw(b.password, u.salt))) return fail(res, 401, 'ایمیل یا رمز اشتباهه');
    if (db.banned[email]) return fail(res, 403, 'حسابت بن شده');
    send(res, 200, { token: newToken(email), profile: profile(u) });
  },
  '/api/me': async (req, res) => { const a = auth(req); if (!a) return fail(res, 401, 'وارد نشدی'); send(res, 200, { profile: profile(a.user) }); },
  '/api/save': async (req, res, b) => {
    const a = auth(req); if (!a) return fail(res, 401, 'وارد نشدی');
    const p = b.profile || {};
    a.user.m = clamp(p.m, 0, 1e6, a.user.m); a.user.h = clamp(p.h, 0, 100, a.user.h);
    // پلیس شدن فقط با مجوزِ سازنده
    if (p.job === 'citizen') a.user.job = 'citizen';
    else if (p.job === 'police' && (a.user.police || a.email === ADMIN_EMAIL)) a.user.job = 'police';
    save(); send(res, 200, { ok: true });
  },
  '/api/update': async (req, res, b) => {
    const a = auth(req); if (!a) return fail(res, 401, 'وارد نشدی');
    if (b.name !== undefined) { const n = cleanName(b.name); if (!n) return fail(res, 400, 'اسم معتبر نیست'); a.user.name = n; }
    if (b.password) { if (typeof b.password !== 'string' || b.password.length < 6 || b.password.length > 100) return fail(res, 400, 'رمز حداقل ۶ حرف باشه'); a.user.salt = crypto.randomBytes(16).toString('hex'); a.user.ph = hashPw(b.password, a.user.salt); }
    save(); send(res, 200, { profile: profile(a.user) });
  },
};

/* ---------- سرورهای آنلاین (روم‌ها) ---------- */
const ROOMS = {
  test: { name: 'تست', pw: 'TAHA', max: 20, players: new Map() },
  free: { name: 'آزاد', pw: '', max: 50, players: new Map() }, // بدون رمز
};
const tickets = new Map(); // ticket -> {room, id, name, email, perm, t}
const pub = p => ({ id: p.id, n: p.name, x: p.x, z: p.z, ry: p.ry, j: p.j, w: p.w });
function bcast(room, obj, exceptId) { const d = 'data: ' + JSON.stringify(obj) + '\n\n'; for (const p of room.players.values()) if (p.id !== exceptId) { try { p.res.write(d); } catch (e) {} } }
setInterval(() => { for (const r of Object.values(ROOMS)) for (const p of r.players.values()) { try { p.res.write(': ping\n\n'); } catch (e) {} } const n = Date.now(); for (const [k, v] of tickets) if (n - v.t > 6 * 3600e3) tickets.delete(k); }, 15000);

const allPlayers = () => Object.values(ROOMS).flatMap(r => [...r.players.values()]);
const sendTo = (p, obj) => { try { p.res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) {} };
function kick(p) { sendTo(p, { t: 'ban' }); try { p.res.end(); } catch (e) {} }
function banEmail(email) {
  if (!email || email === ADMIN_EMAIL) return false;
  db.banned[email] = true; save();
  for (const [t, v] of tickets) if (v.email === email) tickets.delete(t);
  allPlayers().filter(p => p.email === email).forEach(kick);
  return true;
}
function banGuest(name) {
  const n = lower(name); if (!n) return false;
  db.bannedNames[n] = true; save();
  for (const [t, v] of tickets) if (!v.email && lower(v.name) === n) tickets.delete(t);
  allPlayers().filter(p => !p.email && lower(p.name) === n).forEach(kick);
  return true;
}
function banByName(name) {
  const n = lower(name); let hit = false;
  for (const [email, u] of Object.entries(db.users)) if (lower(u.name) === n && banEmail(email)) hit = true;
  if (banGuest(n)) hit = true;
  return hit;
}

routes['/api/join'] = async (req, res, b) => {
  const room = ROOMS[b.room]; if (!room) return fail(res, 404, 'سرور پیدا نشد');
  if (String(b.password || '').trim().toUpperCase() !== room.pw) return fail(res, 403, 'رمز سرور اشتباهه');
  const name = cleanName(b.name), id = String(b.id || '');
  if (!name) return fail(res, 400, 'اسم معتبر نیست');
  if (!/^[a-z0-9]{3,20}$/i.test(id)) return fail(res, 400, 'شناسه نامعتبر');
  const tok = (req.headers.authorization || '').replace(/^Bearer /, ''), te = db.tokens[tok];
  if (te && db.banned[te]) return fail(res, 403, 'حسابت بن شده');
  const a = auth(req);
  if (!a && db.bannedNames[lower(name)]) return fail(res, 403, 'این اسم بن شده');
  if (!room.players.has(id) && room.players.size >= room.max) return fail(res, 409, 'سرور پره');
  const t = crypto.randomBytes(24).toString('hex');
  const perm = !!(a && (a.user.police || a.email === ADMIN_EMAIL));
  tickets.set(t, { room: b.room, id, name, email: a ? a.email : '', perm, t: Date.now(), lastRep: 0 });
  send(res, 200, { ticket: t });
};
routes['/api/send'] = async (req, res, b) => {
  const k = tickets.get(b.t); if (!k) return fail(res, 401, 'نشست منقضی شد');
  const room = ROOMS[k.room], p = room.players.get(k.id), m = b.m || {};
  if (!p) return fail(res, 409, 'به سرور وصل نیستی');
  if (m.t === 'p') {
    p.x = clamp(m.x, -200, 200, p.x); p.z = clamp(m.z, -200, 200, p.z); p.ry = clamp(m.ry, -10, 10, p.ry);
    // ظاهر پلیس فقط برای کسی که مجوز دارد و فقط توی سرور تست
    p.j = (p.perm && k.room === 'test' && m.j) ? 1 : 0;
    p.w = (k.room === 'test' && m.w) ? 1 : 0;
    bcast(room, { t: 'p', id: p.id, n: p.name, x: p.x, z: p.z, ry: p.ry, j: p.j, w: p.w }, p.id);
  }
  else if (m.t === 'c') {
    const txt = String(m.m || '').trim().slice(0, 120); if (!txt) return send(res, 200, { ok: true });
    if (/^⁣?(ADM|RPT)\|/.test(txt)) return send(res, 200, { ok: true }); // دستورهای مدیر دیگه از چت رد نمی‌شن
    const s = txt.replace(/[‌‏\s._\-*]/g, ''); if (BAD.some(w => s.includes(w))) return fail(res, 400, 'پیام فحش داشت');
    const n = Date.now(); if (n - (p.lastChat || 0) < 700) return fail(res, 429, 'آروم‌تر');
    p.lastChat = n; bcast(room, { t: 'c', id: p.id, n: p.name, m: txt }, p.id);
  }
  send(res, 200, { ok: true });
};

/* ---------- گزارش بازیکن ---------- */
routes['/api/report'] = async (req, res, b) => {
  const k = tickets.get(b.t), a = auth(req), rn = k ? k.name : (a ? a.user.name : null);
  if (!rn) return fail(res, 401, 'اول وارد حساب یا یه سرور شو');
  const tn = String(b.target || '').trim().slice(0, 30), r = String(b.reason || '').trim().slice(0, 80);
  if (tn.length < 2) return fail(res, 400, 'اسم بازیکن رو بنویس');
  const key = k || a.user, n = Date.now();
  if (n - (key.lastRep || 0) < 30000) return fail(res, 429, 'چند ثانیه صبر کن');
  key.lastRep = n;
  if (db.reports.length >= 200) db.reports.shift();
  db.reports.push({ rn, tn, r, ts: n }); save();
  send(res, 200, { ok: true });
};

/* ---------- پنل مدیر (فقط ایمیل سازنده) ---------- */
const adm = (req, res) => { const a = auth(req); if (!a || a.email !== ADMIN_EMAIL) { fail(res, 403, 'اجازه نداری'); return null; } return a; };
routes['/api/admin/users'] = async (req, res) => {
  if (!adm(req, res)) return;
  const online = new Set(allPlayers().map(p => p.email).filter(Boolean));
  const users = Object.entries(db.users).map(([email, u]) => ({ email, name: u.name, m: u.m, police: !!u.police, banned: !!db.banned[email], online: online.has(email) }))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  send(res, 200, { users, names: Object.keys(db.bannedNames) });
};
routes['/api/admin/players'] = async (req, res) => {
  if (!adm(req, res)) return;
  send(res, 200, { players: Object.entries(ROOMS).flatMap(([rid, r]) => [...r.players.values()].map(p => ({ id: p.id, name: p.name, room: rid, email: p.email || '', perm: !!p.perm }))) });
};
routes['/api/admin/reports'] = async (req, res) => {
  if (!adm(req, res)) return;
  send(res, 200, { reports: db.reports.map((r, i) => ({ i, rn: r.rn, tn: r.tn, r: r.r, ts: r.ts })) });
};
routes['/api/admin/report-done'] = async (req, res, b) => {
  if (!adm(req, res)) return;
  const i = parseInt(b.i, 10), r = db.reports[i]; if (!r) return fail(res, 404, 'گزارش پیدا نشد');
  db.reports.splice(i, 1); save();
  let banned = false; if (b.ban) banned = banByName(r.tn);
  send(res, 200, { ok: true, banned });
};
routes['/api/admin/ban'] = async (req, res, b) => {
  if (!adm(req, res)) return;
  const email = lower(b.email), name = lower(b.name), on = b.on !== false;
  if (email === ADMIN_EMAIL) return fail(res, 400, 'نمی‌شه خودت رو بن کرد');
  if (!on) {
    if (email) delete db.banned[email];
    if (name) delete db.bannedNames[name];
    save(); return send(res, 200, { ok: true });
  }
  let hit = false;
  if (email) hit = banEmail(email);
  else {
    const p = allPlayers().find(x => x.id === String(b.id || ''));
    const n = name || (p ? lower(p.name) : '');
    if (p && p.email) hit = banEmail(p.email); else if (n) hit = banGuest(n);
  }
  if (!hit) return fail(res, 404, 'پیدا نشد');
  send(res, 200, { ok: true });
};
routes['/api/admin/money'] = async (req, res, b) => {
  if (!adm(req, res)) return;
  const amt = Math.round(clamp(Number(b.amount), -1e6, 1e6, 0)); if (!amt) return fail(res, 400, 'مبلغ نامعتبر');
  const email = lower(b.email);
  if (email) {
    const u = db.users[email]; if (!u) return fail(res, 404, 'حساب پیدا نشد');
    u.m = clamp(u.m + amt, 0, 1e6, u.m); save();
    allPlayers().filter(p => p.email === email).forEach(p => sendTo(p, { t: 'money', amt }));
  } else {
    const ps = allPlayers().filter(p => p.id === String(b.id || '')); if (!ps.length) return fail(res, 404, 'بازیکن آنلاین نیست');
    ps.forEach(p => sendTo(p, { t: 'money', amt }));
  }
  send(res, 200, { ok: true });
};
routes['/api/admin/police'] = async (req, res, b) => {
  if (!adm(req, res)) return;
  const on = !!b.on, email = lower(b.email);
  const apply = p => { p.perm = on; if (!on) p.j = 0; sendTo(p, { t: 'police', on }); };
  if (email) {
    const u = db.users[email]; if (!u) return fail(res, 404, 'حساب پیدا نشد');
    u.police = on; u.job = on ? 'police' : 'citizen'; save();
    allPlayers().filter(p => p.email === email).forEach(apply);
  } else {
    const ps = allPlayers().filter(p => p.id === String(b.id || '')); if (!ps.length) return fail(res, 404, 'بازیکن آنلاین نیست');
    ps.forEach(apply);
  }
  send(res, 200, { ok: true });
};

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && url === '/api/servers') return send(res, 200, { servers: Object.entries(ROOMS).map(([id, r]) => ({ id, name: r.name, count: r.players.size, max: r.max, locked: !!r.pw })) });
  if (req.method === 'GET' && url === '/api/stream') {
    const k = tickets.get(new URL(req.url, 'http://x').searchParams.get('t')); if (!k) return fail(res, 401, 'نشست منقضی شد');
    const room = ROOMS[k.room], old = room.players.get(k.id);
    if (old) { try { old.res.end(); } catch (e) {} }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
    const p = { id: k.id, name: k.name, email: k.email, room: k.room, perm: k.perm, x: 0, z: 45, ry: 3.14, j: 0, w: 0, res };
    room.players.set(k.id, p);
    res.write('data: ' + JSON.stringify({ t: 'snap', list: [...room.players.values()].filter(q => q.id !== k.id).map(pub) }) + '\n\n');
    bcast(room, { t: 'j', id: p.id, n: p.name }, p.id);
    req.on('close', () => { if (room.players.get(k.id) === p) { room.players.delete(k.id); bcast(room, { t: 'l', id: k.id, n: k.name }); } });
    return;
  }
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('%%BACKEND%%', 'same');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
  }
  const h = routes[url];
  if (!h || req.method !== 'POST') return fail(res, 404, 'پیدا نشد');
  if ((url === '/api/login' || url === '/api/register') && limited(req)) return fail(res, 429, 'کمی صبر کن و دوباره امتحان کن');
  try { await h(req, res, await body(req)); } catch (e) { fail(res, 400, 'درخواست نامعتبر'); }
}).listen(PORT, () => console.log('ایران سیتی روی http://localhost:' + PORT));
