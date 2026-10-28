// سرور حساب‌های ایران سیتی
// اجرا: node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB = process.env.DB_FILE || path.join(__dirname, 'data.json');

const ADMIN_EMAILS = [...new Set([
  'sajjadrip4@gmail.com',
  'callofdutytja1948@gmail.com'
].concat(String(process.env.ADMIN_EMAIL || '').split(','))
  .map(s => s.trim().toLowerCase())
  .filter(Boolean))];

const isAdminEmail = e =>
  ADMIN_EMAILS.includes(String(e || '').toLowerCase());

let db = { users: {}, tokens: {} };

try {
  db = JSON.parse(fs.readFileSync(DB, 'utf8'));
} catch (e) {}

db.users = db.users || {};
db.tokens = db.tokens || {};
db.banned = db.banned || {};
db.bannedNames = db.bannedNames || {};
db.reports = db.reports || [];
db.homes = db.homes || {};
db.jailed = db.jailed || {};

const WEATHER_TYPES = [
  'clear', 'sunny', 'rain', 'snow', 'storm', 'fog'
];

db.weather = WEATHER_TYPES.includes(db.weather)
  ? db.weather
  : 'clear';

// مقداردهی اولیهٔ جم برای حساب‌های قبلی
for (const u of Object.values(db.users)) {
  if (u.m === 99999) u.m = 200;
  if (!Number.isFinite(u.diamonds)) u.diamonds = 0;
}

let dirty = false;

const save = () => {
  dirty = true;
};

function flush() {
  if (!dirty) return;
  dirty = false;

  try {
    fs.writeFileSync(DB + '.tmp', JSON.stringify(db));
    fs.renameSync(DB + '.tmp', DB);
  } catch (e) {
    dirty = true;
    console.error('خطا در ذخیره دیتابیس:', e.message);
  }
}

setInterval(flush, 2000);

['SIGINT', 'SIGTERM'].forEach(s =>
  process.on(s, () => {
    flush();
    process.exit(0);
  })
);

const send = (res, code, obj) => {
  if (res.writableEnded || res.destroyed) return;

  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  });

  res.end(JSON.stringify(obj));
};

const fail = (res, code, msg) =>
  send(res, code, { error: msg });

function body(req) {
  return new Promise((ok, no) => {
    let s = '';

    req.on('data', d => {
      s += d;

      if (s.length > 10000) {
        no(new Error('big'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        ok(JSON.parse(s || '{}'));
      } catch (e) {
        no(e);
      }
    });

    req.on('error', no);
  });
}

const hashPw = (pw, salt) =>
  crypto.scryptSync(pw, salt, 32).toString('hex');

const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));

  return x.length === y.length &&
    crypto.timingSafeEqual(x, y);
};

const okEmail = e =>
  typeof e === 'string' &&
  e.length <= 120 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

const BAD = [
  'کیر', 'کص', 'کون', 'جنده', 'گایید',
  'حرومزاده', 'کثافت', 'عوضی', 'بیشرف', 'لعنتی'
];

const cleanName = n => {
  n = String(n || '').trim();

  if (n.length < 2 || n.length > 14) return null;

  const s = n.replace(/[\u200c\u200f\s._\-*]/g, '');

  return BAD.some(b => s.includes(b)) ? null : n;
};

const clamp = (v, a, b, d) =>
  typeof v === 'number' && isFinite(v)
    ? Math.max(a, Math.min(b, v))
    : d;

const lower = s => String(s || '').trim().toLowerCase();

const CAR_IDS = [
  'pride', 'snapp', 'paykan', 'samand', 'p405',
  'nissan', 'p206', 'yamaha100', 'honda125',
  'cb1300', 'ninja', 'heli'
];

const CAR_T = [1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15];

const left = t => Math.max(0, (t || 0) - Date.now());

const jailOf = (email, name) =>
  email && db.users[email]
    ? left(db.users[email].jailUntil)
    : left(db.jailed[lower(name)]);

const profile = u => ({
  name: u.name,
  m: u.m,
  diamonds: u.diamonds || 0,
  h: u.h,
  job: u.job,
  police: !!u.police,
  pay: u.pay || 0,
  cars: u.cars || [],
  jailMs: left(u.jailUntil),
  mv: u.mv || 0
});

const HOMES = {
  h1: { n: 'آپارتمان کوچک', p: 3000, r: 60 },
  h2: { n: 'آپارتمان نوساز', p: 5000, r: 100 },
  h3: { n: 'خانه‌ی حیاط‌دار', p: 8000, r: 160 },
  h4: { n: 'خانه‌ی دوبلکس', p: 12000, r: 240 },
  h5: { n: 'ویلای باغ', p: 20000, r: 380 },
  h6: { n: 'ویلای لوکس', p: 32000, r: 580 },
  h7: { n: 'عمارت', p: 60000, r: 1050 },
  h8: { n: 'پنت‌هاوس', p: 100000, r: 1700 }
};

const RENT_CAP_H = 24;

const rentOf = (id, h, n) =>
  Math.floor(
    HOMES[id].r *
    Math.min(RENT_CAP_H, Math.max(0, n - (h.t || n)) / 3600000)
  );

const bump = u => {
  u.mv = (u.mv || 0) + 1;
};

function newToken(email) {
  const t = crypto.randomBytes(32).toString('hex');
  db.tokens[t] = email;
  save();
  return t;
}

function auth(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const e = db.tokens[t];

  return e && db.users[e] && !db.banned[e]
    ? { email: e, user: db.users[e], token: t }
    : null;
}

const hits = new Map();

function limited(req) {
  const ip = String(
    req.headers['x-real-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0] ||
    req.socket.remoteAddress
  ).trim();

  const n = Date.now();
  const h = hits.get(ip) || { c: 0, t: n };

  if (n - h.t > 60000) {
    h.c = 0;
    h.t = n;
  }

  h.c++;
  hits.set(ip, h);

  return h.c > 20;
}

const routes = {
  '/api/register': async (req, res, b) => {
    const email = String(b.email || '').trim().toLowerCase();
    const name = cleanName(b.name);

    if (!okEmail(email))
      return fail(res, 400, 'ایمیل معتبر نیست');

    if (typeof b.password !== 'string' ||
        b.password.length < 6 ||
        b.password.length > 100)
      return fail(res, 400, 'رمز حداقل ۶ حرف باشه');

    if (!name)
      return fail(res, 400, 'اسم معتبر نیست');

    if (db.users[email])
      return fail(res, 409, 'این ایمیل قبلاً ثبت شده');

    const salt = crypto.randomBytes(16).toString('hex');

    db.users[email] = {
      salt,
      ph: hashPw(b.password, salt),
      name,
      m: 200,
      diamonds: 0,
      h: 100,
      job: 'citizen'
    };

    send(res, 200, {
      token: newToken(email),
      profile: profile(db.users[email])
    });
  },

  '/api/login': async (req, res, b) => {
    const email = String(b.email || '').trim().toLowerCase();
    const u = db.users[email];

    if (!u || typeof b.password !== 'string' ||
        !same(u.ph, hashPw(b.password, u.salt)))
      return fail(res, 401, 'ایمیل یا رمز اشتباهه');

    if (db.banned[email])
      return fail(res, 403, 'حسابت بن شده');

    // برای حساب‌های قدیمی که هنوز فیلد جم ندارند
    if (!Number.isFinite(u.diamonds))
      u.diamonds = 0;

    send(res, 200, {
      token: newToken(email),
      profile: profile(u)
    });
  },

  '/api/me': async (req, res) => {
    const a = auth(req);

    if (!a) return fail(res, 401, 'وارد نشدی');

    send(res, 200, { profile: profile(a.user) });
  },

  '/api/save': async (req, res, b) => {
    const a = auth(req);

    if (!a) return fail(res, 401, 'وارد نشدی');

    const p = b.profile || {};

    const stale =
      b.mv !== undefined &&
      (b.mv | 0) !== (a.user.mv || 0);

    if (!stale)
      a.user.m = clamp(p.m, 0, 1e6, a.user.m);

    a.user.h = clamp(p.h, 0, 100, a.user.h);

    if (p.job === 'citizen')
      a.user.job = 'citizen';
    else if (
      p.job === 'police' &&
      (a.user.police || isAdminEmail(a.email))
    )
      a.user.job = 'police';

    a.user.pay = clamp(p.pay, 0, 1e6, a.user.pay || 0);

    if (p.job === 'banker' || p.job === 'baker')
      a.user.job = p.job;

    if (Array.isArray(p.cars)) {
      a.user.cars = [...new Set([
        ...(a.user.cars || []),
        ...p.cars.filter(c => CAR_IDS.includes(c))
      ])];
    }

    // موجودی جم فقط از سمت سرور تغییر می‌کند.
    // مقدار جم ارسالی از HTML در این مسیر پذیرفته نمی‌شود.

    save();

    send(res, 200, stale
      ? { ok: true, stale: true, m: a.user.m, mv: a.user.mv || 0 }
      : { ok: true });
  },

  '/api/update': async (req, res, b) => {
    const a = auth(req);

    if (!a) return fail(res, 401, 'وارد نشدی');

    if (b.name !== undefined) {
      const n = cleanName(b.name);

      if (!n) return fail(res, 400, 'اسم معتبر نیست');

      a.user.name = n;
    }

    if (b.password) {
      if (typeof b.password !== 'string' ||
          b.password.length < 6 ||
          b.password.length > 100)
        return fail(res, 400, 'رمز حداقل ۶ حرف باشه');

      a.user.salt = crypto.randomBytes(16).toString('hex');
      a.user.ph = hashPw(b.password, a.user.salt);
    }

    save();
    send(res, 200, { profile: profile(a.user) });
  }
};

/* ---------- سرورهای آنلاین ---------- */

const ROOMS = {
  test: {
    name: 'تست',
    pw: 'TAHA',
    max: 20,
    players: new Map()
  },

  free: {
    name: 'آزاد',
    pw: '',
    max: 50,
    players: new Map()
  }
};

const tickets = new Map();

const pub = p => ({
  id: p.id,
  n: p.name,
  x: p.x,
  z: p.z,
  ry: p.ry,
  j: p.j,
  w: p.w,
  cr: p.cr || 0,
  jb: p.jb || 0,
  y: p.y || 0
});

function bcast(room, obj, exceptId) {
  const d = 'data: ' + JSON.stringify(obj) + '\n\n';

  for (const p of room.players.values()) {
    if (p.id !== exceptId) {
      try {
        p.res.write(d);
      } catch (e) {}
    }
  }
}

const allPlayers = () =>
  Object.values(ROOMS).flatMap(r => [...r.players.values()]);

const sendTo = (p, obj) => {
  try {
    p.res.write('data: ' + JSON.stringify(obj) + '\n\n');
  } catch (e) {}
};

function kick(p) {
  sendTo(p, { t: 'ban' });

  try {
    p.res.end();
  } catch (e) {}
}

function banEmail(email) {
  if (!email || isAdminEmail(email)) return false;

  db.banned[email] = true;
  save();

  for (const [t, v] of tickets) {
    if (v.email === email) tickets.delete(t);
  }

  allPlayers()
    .filter(p => p.email === email)
    .forEach(kick);

  return true;
}

function banGuest(name) {
  const n = lower(name);

  if (!n) return false;

  db.bannedNames[n] = true;
  save();

  for (const [t, v] of tickets) {
    if (!v.email && lower(v.name) === n)
      tickets.delete(t);
  }

  allPlayers()
    .filter(p => !p.email && lower(p.name) === n)
    .forEach(kick);

  return true;
}

function banByName(name) {
  const n = lower(name);
  let hit = false;

  for (const [email, u] of Object.entries(db.users)) {
    if (lower(u.name) === n && banEmail(email))
      hit = true;
  }

  if (banGuest(n)) hit = true;

  return hit;
}

setInterval(() => {
  for (const r of Object.values(ROOMS)) {
    for (const p of r.players.values()) {
      try {
        p.res.write(': ping\n\n');
      } catch (e) {}
    }
  }

  const n = Date.now();

  for (const [k, v] of tickets) {
    if (n - v.t > 6 * 3600e3)
      tickets.delete(k);
  }
}, 15000);

routes['/api/join'] = async (req, res, b) => {
  const room = ROOMS[b.room];

  if (!room)
    return fail(res, 404, 'سرور پیدا نشد');

  if (String(b.password || '').trim().toUpperCase() !== room.pw)
    return fail(res, 403, 'رمز سرور اشتباهه');

  const name = cleanName(b.name);
  const id = String(b.id || '');

  if (!name)
    return fail(res, 400, 'اسم معتبر نیست');

  if (!/^[a-z0-9]{3,20}$/i.test(id))
    return fail(res, 400, 'شناسه نامعتبر');

  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  const te = db.tokens[tok];

  if (te && db.banned[te])
    return fail(res, 403, 'حسابت بن شده');

  const a = auth(req);

  if (!a && db.bannedNames[lower(name)])
    return fail(res, 403, 'این اسم بن شده');

  if (!room.players.has(id) && room.players.size >= room.max)
    return fail(res, 409, 'سرور پره');

  const t = crypto.randomBytes(24).toString('hex');

  const perm = !!(
    a && (a.user.police || isAdminEmail(a.email))
  );

  tickets.set(t, {
    room: b.room,
    id,
    name,
    email: a ? a.email : '',
    perm,
    t: Date.now(),
    lastRep: 0
  });

  send(res, 200, { ticket: t });
};

routes['/api/send'] = async (req, res, b) => {
  const k = tickets.get(b.t);

  if (!k)
    return fail(res, 401, 'نشست منقضی شد');

  const room = ROOMS[k.room];
  const p = room.players.get(k.id);
  const m = b.m || {};

  if (!p)
    return fail(res, 409, 'به سرور وصل نیستی');

  if (m.t === 'l') {
    if (room.players.get(k.id) === p) {
      room.players.delete(k.id);
      bcast(room, { t: 'l', id: k.id, n: k.name });

      try {
        p.res.end();
      } catch (e) {}
    }

    return send(res, 200, { ok: true });
  }

  if (m.t === 'p') {
    p.x = clamp(m.x, -720, 720, p.x);
    p.z = clamp(m.z, -720, 720, p.z);
    p.ry = clamp(m.ry, -10, 10, p.ry);

    p.j = (p.perm && k.room === 'test' && m.j) ? 1 : 0;
    p.w = (k.room === 'test' && m.w) ? 1 : 0;
    p.cr = CAR_T.includes(m.cr) ? m.cr : 0;
    p.jb = [0, 1, 2].includes(m.jb) ? m.jb : 0;
    p.y = clamp(m.y, 0, 400, 0);

    bcast(room, {
      t: 'p',
      id: p.id,
      n: p.name,
      x: p.x,
      z: p.z,
      ry: p.ry,
      j: p.j,
      w: p.w,
      cr: p.cr || 0,
      jb: p.jb || 0,
      y: p.y || 0
    }, p.id);
  } else if (m.t === 'c') {
    const txt = String(m.m || '').trim().slice(0, 120);

    if (!txt)
      return send(res, 200, { ok: true });

    if (/^\u2063?(ADM|RPT)\|/.test(txt))
      return send(res, 200, { ok: true });

    const s = txt.replace(/[\u200c\u200f\s._\-*]/g, '');

    if (BAD.some(w => s.includes(w)))
      return fail(res, 400, 'پیام فحش داشت');

    const n = Date.now();

    if (n - (p.lastChat || 0) < 700)
      return fail(res, 429, 'آروم‌تر');

    p.lastChat = n;

    bcast(room, {
      t: 'c',
      id: p.id,
      n: p.name,
      m: txt
    }, p.id);
  }

  send(res, 200, { ok: true });
};

/* ---------- گزارش بازیکن ---------- */

routes['/api/report'] = async (req, res, b) => {
  const k = tickets.get(b.t);
  const a = auth(req);
  const rn = k ? k.name : (a ? a.user.name : null);

  if (!rn)
    return fail(res, 401, 'اول وارد حساب یا یه سرور شو');

  const tn = String(b.target || '').trim().slice(0, 30);
  const r = String(b.reason || '').trim().slice(0, 80);

  if (tn.length < 2)
    return fail(res, 400, 'اسم بازیکن رو بنویس');

  const key = k || a.user;
  const n = Date.now();

  if (n - (key.lastRep || 0) < 30000)
    return fail(res, 429, 'چند ثانیه صبر کن');

  key.lastRep = n;

  if (db.reports.length >= 200)
    db.reports.shift();

  db.reports.push({ rn, tn, r, ts: n });
  save();

  send(res, 200, { ok: true });
};

/* ---------- انتقال سکه ---------- */

routes['/api/transfer'] = async (req, res, b) => {
  const a = auth(req);

  if (!a)
    return fail(res, 401, 'وارد نشدی');

  const amt = Math.floor(Number(b.amount));

  if (!(amt >= 1) || amt > 1e6)
    return fail(res, 400, 'مبلغ نامعتبر');

  const n = Date.now();

  if (n - (a.user.lastXfer || 0) < 3000)
    return fail(res, 429, 'چند ثانیه صبر کن');

  const q = lower(b.to);

  if (!q)
    return fail(res, 400, 'گیرنده رو بنویس');

  let toEmail = null;

  if (q.includes('@')) {
    toEmail = db.users[q] ? q : null;
  } else {
    const hit = Object.entries(db.users)
      .filter(([e, u]) => lower(u.name) === q)
      .map(([e]) => e);

    if (hit.length > 1)
      return fail(res, 409, 'چند حساب با این اسم هست؛ ایمیلش رو بنویس');

    toEmail = hit[0] || null;
  }

  if (!toEmail)
    return fail(res, 404, 'حسابی با این اسم یا ایمیل پیدا نشد');

  if (toEmail === a.email)
    return fail(res, 400, 'نمی‌تونی به خودت بفرستی');

  if (db.banned[toEmail])
    return fail(res, 400, 'این حساب بن شده');

  const to = db.users[toEmail];

  if ((a.user.m || 0) < amt)
    return fail(res, 400, 'سکه‌ات کافی نیست');

  if ((to.m || 0) + amt > 1e6)
    return fail(res, 400, 'موجودی گیرنده بیشتر از سقف می‌شه');

  a.user.m -= amt;
  to.m = (to.m || 0) + amt;
  a.user.lastXfer = n;

  bump(a.user);
  bump(to);
  save();

  allPlayers()
    .filter(p => p.email === toEmail)
    .forEach(p => sendTo(p, {
      t: 'money',
      amt,
      from: a.user.name,
      mv: to.mv
    }));

  send(res, 200, {
    ok: true,
    m: a.user.m,
    mv: a.user.mv,
    name: to.name
  });
};

/* ---------- خانه‌ها ---------- */

function homesView(email) {
  const n = Date.now();
  const out = {};

  for (const id of Object.keys(HOMES)) {
    const h = db.homes[id];
    const u = h && db.users[h.o];

    out[id] = h && u
      ? {
          o: u.name,
          me: h.o === email,
          rent: h.o === email ? rentOf(id, h, n) : 0
        }
      : null;
  }

  return out;
}

routes['/api/homes'] = async (req, res) => {
  const a = auth(req);

  send(res, 200, {
    homes: homesView(a ? a.email : ''),
    defs: HOMES
  });
};

routes['/api/home/buy'] = async (req, res, b) => {
  const a = auth(req);

  if (!a)
    return fail(res, 401, 'وارد نشدی');

  const id = String(b.id || '');
  const d = HOMES[id];

  if (!d)
    return fail(res, 404, 'ملک پیدا نشد');

  if (db.homes[id] && db.users[db.homes[id].o])
    return fail(res, 409, 'این ملک قبلاً فروخته شده');

  if (Object.values(db.homes).filter(h => h.o === a.email).length >= 3)
    return fail(res, 400, 'حداکثر ۳ ملک می‌تونی داشته باشی');

  if ((a.user.m || 0) < d.p)
    return fail(res, 400, 'سکه‌ات کافی نیست');

  a.user.m -= d.p;
  db.homes[id] = { o: a.email, t: Date.now() };

  bump(a.user);
  save();

  send(res, 200, {
    ok: true,
    m: a.user.m,
    mv: a.user.mv,
    homes: homesView(a.email)
  });
};

routes['/api/home/sell'] = async (req, res, b) => {
  const a = auth(req);

  if (!a)
    return fail(res, 401, 'وارد نشدی');

  const id = String(b.id || '');
  const d = HOMES[id];
  const h = db.homes[id];

  if (!d || !h || h.o !== a.email)
    return fail(res, 404, 'این ملک مال تو نیست');

  const back = Math.floor(d.p * 0.6) + rentOf(id, h, Date.now());

  a.user.m = Math.min(1e6, (a.user.m || 0) + back);

  delete db.homes[id];

  bump(a.user);
  save();

  send(res, 200, {
    ok: true,
    m: a.user.m,
    mv: a.user.mv,
    back,
    homes: homesView(a.email)
  });
};

routes['/api/home/rent'] = async (req, res, b) => {
  const a = auth(req);

  if (!a)
    return fail(res, 401, 'وارد نشدی');

  const n = Date.now();
  let sum = 0;

  for (const [id, h] of Object.entries(db.homes)) {
    if (h.o === a.email && HOMES[id]) {
      sum += rentOf(id, h, n);
      h.t = n;
    }
  }

  if (sum < 1)
    return fail(res, 400, 'هنوز اجاره‌ای جمع نشده');

  a.user.m = Math.min(1e6, (a.user.m || 0) + sum);

  bump(a.user);
  save();

  send(res, 200, {
    ok: true,
    m: a.user.m,
    mv: a.user.mv,
    amt: sum,
    homes: homesView(a.email)
  });
};

/* ---------- پنل مدیر ---------- */
/* ---------- خرج کردن الماس حساب ---------- */

routes['/api/diamonds/spend'] = async (req, res, b) => {
  const a = auth(req);

  if (!a)
    return fail(res, 401, 'اول وارد حسابت شو');

  const amount = Math.floor(Number(b.amount));

  // فعلاً فقط بازکردن فوری صندوق با ۱۸ الماس مجاز است.
  if (b.reason !== 'chest_instant' || amount !== 18)
    return fail(res, 400, 'درخواست خرج الماس نامعتبر است');

  const u = a.user;

  if (!Number.isFinite(u.diamonds))
    u.diamonds = 0;

  if (u.diamonds < amount)
    return fail(res, 400, 'الماس حسابت کافی نیست');

  // کم‌کردن الماس از حساب واقعی کاربر
  u.diamonds -= amount;

  bump(u);
  save();

  // به‌روزرسانی موجودی برای کاربرانی که با این حساب آنلاین‌اند
  allPlayers()
    .filter(p => p.email === a.email)
    .forEach(p => sendTo(p, {
      t: 'diamonds',
      diamonds: u.diamonds,
      mv: u.mv
    }));

  return send(res, 200, {
    ok: true,
    diamonds: u.diamonds,
    mv: u.mv
  });
};

const adm = (req, res) => {
  const a = auth(req);

  if (!a || !isAdminEmail(a.email)) {
    fail(res, 403, 'اجازه نداری');
    return null;
  }

  return a;
};

routes['/api/admin/weather'] = async (req, res, b) => {
  if (!adm(req, res)) return;

  const weather = String(b.weather || '');

  if (!WEATHER_TYPES.includes(weather))
    return fail(res, 400, 'آب‌وهوای نامعتبر');

  db.weather = weather;
  save();

  for (const room of Object.values(ROOMS)) {
    bcast(room, {
      t: 'weather',
      weather: db.weather
    });
  }

  send(res, 200, {
    ok: true,
    weather: db.weather
  });
};

routes['/api/admin/users'] = async (req, res) => {
  if (!adm(req, res)) return;

  const online = new Set(
    allPlayers().map(p => p.email).filter(Boolean)
  );

  const users = Object.entries(db.users)
    .map(([email, u]) => ({
      email,
      name: u.name,
      m: u.m,
      diamonds: u.diamonds || 0,
      police: !!u.police,
      banned: !!db.banned[email],
      online: online.has(email),
      jailMs: left(u.jailUntil)
    }))
    .sort((a, b) =>
      (b.online - a.online) || a.name.localeCompare(b.name)
    );

  const jailed = Object.entries(db.jailed)
    .map(([name, t]) => ({ name, ms: left(t) }))
    .filter(x => x.ms > 0);

  send(res, 200, {
    users,
    names: Object.keys(db.bannedNames),
    jailed
  });
};

routes['/api/admin/players'] = async (req, res) => {
  if (!adm(req, res)) return;

  send(res, 200, {
    players: Object.entries(ROOMS).flatMap(([rid, r]) =>
      [...r.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        room: rid,
        email: p.email || '',
        perm: !!p.perm,
        jailMs: jailOf(p.email, p.name)
      }))
    )
  });
};

routes['/api/admin/reports'] = async (req, res) => {
  if (!adm(req, res)) return;

  send(res, 200, {
    reports: db.reports.map((r, i) => ({
      i,
      rn: r.rn,
      tn: r.tn,
      r: r.r,
      ts: r.ts
    }))
  });
};

routes['/api/admin/report-done'] = async (req, res, b) => {
  if (!adm(req, res)) return;

  const i = parseInt(b.i, 10);
  const r = db.reports[i];

  if (!r)
    return fail(res, 404, 'گزارش پیدا نشد');

  db.reports.splice(i, 1);
  save();

  let banned = false;

  if (b.ban === 'jail')
    jailName(r.tn, 120);
  else if (b.ban)
    banned = banByName(r.tn);

  send(res, 200, { ok: true, banned });
};

routes['/api/admin/ban'] = async (req, res, b) => {
  if (!adm(req, res)) return;

  const email = lower(b.email);
  const name = lower(b.name);
  const on = b.on !== false;

  if (isAdminEmail(email))
    return fail(res, 400, 'نمی‌شه مدیر رو بن کرد');

  if (!on) {
    if (email) delete db.banned[email];
    if (name) delete db.bannedNames[name];

    save();

    return send(res, 200, { ok: true });
  }

  let hit = false;

  if (email) {
    hit = banEmail(email);
  } else {
    const p = allPlayers().find(x => x.id === String(b.id || ''));
    const n = name || (p ? lower(p.name) : '');

    if (p && p.email)
      hit = banEmail(p.email);
    else if (n)
      hit = banGuest(n);
  }

  if (!hit)
    return fail(res, 404, 'پیدا نشد');

  send(res, 200, { ok: true });
};

routes['/api/admin/money'] = async (req, res, b) => {
  if (!adm(req, res)) return;

  const amt = Math.round(clamp(Number(b.amount), -1e6, 1e6, 0));

  if (!amt)
    return fail(res, 400, 'مبلغ نامعتبر');

  const email = lower(b.email);

  if (email) {
    const u = db.users[email];

    if (!u)
      return fail(res, 404, 'حساب پیدا نشد');

    u.m = clamp(u.m + amt, 0, 1e6, u.m);

    bump(u);
    save();

    allPlayers()
      .filter(p => p.email === email)
      .forEach(p => sendTo(p, {
        t: 'money',
        amt,
        mv: u.mv
      }));
  } else {
    const ps = allPlayers()
      .filter(p => p.id === String(b.id || ''));

    if (!ps.length)
      return fail(res, 404, 'بازیکن آنلاین نیست');

    ps.forEach(p => sendTo(p, { t: 'money', amt }));
  }

  send(res, 200, { ok: true });
};

/* ---------- افزودن جم توسط مدیر ---------- */

routes['/api/admin/diamonds'] = async (req, res, b) => {
  if (!adm(req, res)) return;

  const amt = Math.floor(Number(b.amount));

  if (!Number.isFinite(amt) || amt < 1 || amt > 1000000)
    return fail(res, 400, 'مقدار جم نامعتبر است');

  const email = lower(b.email);

  // حساب ثبت‌شده: جم داخل دیتابیس ذخیره می‌شود
  if (email) {
    const u = db.users[email];

    if (!u)
      return fail(res, 404, 'حساب پیدا نشد');

    u.diamonds = Math.min(
      1000000,
      Math.max(0, Number(u.diamonds) || 0) + amt
    );

    bump(u);
    save();

    // اگر کاربر آنلاین باشد، موجودی جدید برایش فرستاده می‌شود
    allPlayers()
      .filter(p => p.email === email)
      .forEach(p => sendTo(p, {
        t: 'diamonds',
        diamonds: u.diamonds,
        mv: u.mv
      }));

    return send(res, 200, {
      ok: true,
      diamonds: u.diamonds
    });
  }

  // مهمان آنلاین حساب دائمی ندارد
  const ps = allPlayers().filter(
    p => p.id === String(b.id || '')
  );

  if (!ps.length)
    return fail(res, 404, 'بازیکن آنلاین نیست یا حساب پیدا نشد');

  ps.forEach(p => sendTo(p, {
    t: 'diamonds',
    amount: amt
  }));

  send(res, 200, { ok: true });
};

routes['/api/admin/police'] = async (req, res, b) => {
  if (!adm(req, res)) return;

  const on = !!b.on;
  const email = lower(b.email);

  const apply = p => {
    p.perm = on;

    if (!on) p.j = 0;

    sendTo(p, { t: 'police', on });
  };

  if (email) {
    const u = db.users[email];

    if (!u)
      return fail(res, 404, 'حساب پیدا نشد');

    u.police = on;
    u.job = on ? 'police' : 'citizen';

    save();

    allPlayers()
      .filter(p => p.email === email)
      .forEach(apply);
  } else {
    const ps = allPlayers()
      .filter(p => p.id === String(b.id || ''));

    if (!ps.length)
      return fail(res, 404, 'بازیکن آنلاین نیست');

    ps.forEach(apply);
  }

  send(res, 200, { ok: true });
};

/* ---------- زندان ---------- */

function setJail(email, name, mins) {
  const until = mins > 0
    ? Date.now() + mins * 60000
    : 0;

  if (email && db.users[email]) {
    if (until)
      db.users[email].jailUntil = until;
    else
      delete db.users[email].jailUntil;
  } else if (name) {
    const n = lower(name);

    if (until)
      db.jailed[n] = until;
    else
      delete db.jailed[n];
  }

  save();

  const ms = until ? until - Date.now() : 0;

  allPlayers()
    .filter(p =>
      email
        ? p.email === email
        : (!p.email && lower(p.name) === lower(name))
    )
    .forEach(p => sendTo(p, { t: 'jail', ms }));
}

function jailName(name, mins) {
  const n = lower(name);

  if (!n) return;

  for (const [email, u] of Object.entries(db.users)) {
    if (lower(u.name) === n && !isAdminEmail(email))
      setJail(email, '', mins);
  }

  setJail('', n, mins);
}

routes['/api/admin/jail'] = async (req, res, b) => {
  if (!adm(req, res)) return;

  const mins = Math.round(
    clamp(Number(b.minutes), 0, 10080, 0)
  );

  let email = lower(b.email);
  let name = String(b.name || '');

  if (!email && b.id) {
    const p = allPlayers().find(x => x.id === String(b.id));

    if (!p)
      return fail(res, 404, 'بازیکن آنلاین نیست');

    email = p.email || '';
    name = p.name;
  }

  if (isAdminEmail(email))
    return fail(res, 400, 'نمی‌شه مدیر رو زندانی کرد');

  if (email) {
    if (!db.users[email])
      return fail(res, 404, 'حساب پیدا نشد');

    setJail(email, '', mins);
  } else if (lower(name)) {
    jailName(name, mins);
  } else {
    return fail(res, 400, 'مشخص نیست');
  }

  send(res, 200, { ok: true });
};

/* ---------- راه‌اندازی HTTP ---------- */

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'OPTIONS')
    return send(res, 204, {});

  if (req.method === 'GET' && url === '/api/servers') {
    return send(res, 200, {
      servers: Object.entries(ROOMS).map(([id, r]) => ({
        id,
        name: r.name,
        count: r.players.size,
        max: r.max,
        locked: !!r.pw
      }))
    });
  }

  if (req.method === 'GET' && url === '/api/stream') {
    const k = tickets.get(
      new URL(req.url, 'http://x').searchParams.get('t')
    );

    if (!k)
      return fail(res, 401, 'نشست منقضی شد');

    const room = ROOMS[k.room];
    const old = room.players.get(k.id);

    if (old) {
      try {
        old.res.end();
      } catch (e) {}
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });

    const p = {
      id: k.id,
      name: k.name,
      email: k.email,
      room: k.room,
      perm: k.perm,
      x: 0,
      z: 45,
      ry: 3.14,
      j: 0,
      w: 0,
      res
    };

    room.players.set(k.id, p);

    sendTo(p, {
      t: 'weather',
      weather: db.weather
    });

    res.write('data: ' + JSON.stringify({
      t: 'snap',
      list: [...room.players.values()]
        .filter(q => q.id !== k.id)
        .map(pub)
    }) + '\n\n');

    const jm = jailOf(k.email, k.name);

    if (jm > 0)
      sendTo(p, { t: 'jail', ms: jm });

    bcast(room, {
      t: 'j',
      id: p.id,
      n: p.name
    }, p.id);

    req.on('close', () => {
      if (room.players.get(k.id) === p) {
        room.players.delete(k.id);

        bcast(room, {
          t: 'l',
          id: k.id,
          n: k.name
        });
      }
    });

    return;
  }

  if (req.method === 'GET' &&
      (url === '/' || url === '/index.html')) {
    try {
      const html = fs.readFileSync(
        path.join(__dirname, 'index.html'),
        'utf8'
      ).replace('%%BACKEND%%', 'same');

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8'
      });

      return res.end(html);
    } catch (e) {
      return fail(res, 500, 'فایل index.html پیدا نشد');
    }
  }

  const h = routes[url];

  if (!h || req.method !== 'POST')
    return fail(res, 404, 'پیدا نشد');

  if ((url === '/api/login' || url === '/api/register') &&
      limited(req)) {
    return fail(res, 429, 'کمی صبر کن و دوباره امتحان کن');
  }

  try {
    await h(req, res, await body(req));
  } catch (e) {
    console.error('خطای درخواست:', e.message);

    if (!res.headersSent)
      fail(res, 400, 'درخواست نامعتبر');
  }
}).listen(PORT, () => {
  console.log('ایران سیتی روی پورت ' + PORT);
});
