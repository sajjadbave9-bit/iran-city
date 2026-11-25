/* ========== بخش مستقل مدرسه ارجمند ========== */
// این بخش را در server.js قبل از قسمت «راه‌اندازی HTTP» قرار بده.
// داده‌ها و حساب‌های مدرسه جدا از حساب‌های بازی ایران‌سیتی نگهداری می‌شوند.

db.schoolStudents = db.schoolStudents || {};
db.schoolTokens = db.schoolTokens || {};
db.schoolAdminTokens = db.schoolAdminTokens || {};
db.schoolPosts = db.schoolPosts || [];

const SCHOOL_ADMIN_PASSWORD = String(process.env.SCHOOL_ADMIN_PASSWORD || 'SAHED').toUpperCase();
const SCHOOL_GRADES = ['اول','دوم','سوم','چهارم','پنجم','ششم','هفتم','هشتم','نهم','دهم','یازدهم','دوازدهم'];

const schoolPublic = s => ({
  username: s.username,
  name: s.name,
  grade: s.grade,
  created: s.created,
  study: s.study || {},
  tasks: s.tasks || [],
  goal: s.goal || 60
});

function schoolToken(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}
function schoolStudent(req) {
  const username = db.schoolTokens[schoolToken(req)];
  return username && db.schoolStudents[username]
    ? db.schoolStudents[username] : null;
}
function schoolAdmin(req) {
  return !!db.schoolAdminTokens[schoolToken(req)];
}
function schoolNewToken(username, admin) {
  const token = crypto.randomBytes(32).toString('hex');
  (admin ? db.schoolAdminTokens : db.schoolTokens)[token] = admin ? true : username;
  save();
  return token;
}
function schoolFail(res, code, error) {
  return send(res, code, { error });
}

async function schoolApi(req, res, url) {
  if (req.method === 'GET' && url === '/api/school/ping')
    return send(res, 200, { ok: true, service: 'arjmand-school' });

  let b = {};
  if (req.method === 'POST') {
    try { b = await body(req); }
    catch (e) { return schoolFail(res, 400, 'درخواست نامعتبر'); }
  }

  if (req.method === 'POST' && url === '/api/school/register') {
    const username = String(b.username || '').trim().toLowerCase();
    const name = String(b.name || '').trim();
    const grade = String(b.grade || '').trim();
    if (!/^[a-z0-9_]{3,20}$/i.test(username)) return schoolFail(res, 400, 'نام کاربری باید ۳ تا ۲۰ حرف انگلیسی، عدد یا _ باشد.');
    if (name.length < 3 || name.length > 70) return schoolFail(res, 400, 'نام و نام خانوادگی معتبر نیست.');
    if (!SCHOOL_GRADES.includes(grade)) return schoolFail(res, 400, 'پایهٔ تحصیلی معتبر نیست.');
    if (typeof b.password !== 'string' || b.password.length < 6 || b.password.length > 100) return schoolFail(res, 400, 'رمز عبور حداقل ۶ نویسه باشد.');
    if (db.schoolStudents[username]) return schoolFail(res, 409, 'این نام کاربری قبلاً گرفته شده است.');
    const salt = crypto.randomBytes(16).toString('hex');
    db.schoolStudents[username] = {
      username, name, grade, salt, ph: hashPw(b.password, salt),
      created: Date.now(), study: {}, tasks: [], goal: 60
    };
    save();
    return send(res, 200, { ok: true, token: schoolNewToken(username, false), student: schoolPublic(db.schoolStudents[username]) });
  }

  if (req.method === 'POST' && url === '/api/school/login') {
    const username = String(b.username || '').trim().toLowerCase();
    const s = db.schoolStudents[username];
    if (!s || typeof b.password !== 'string' || !same(s.ph, hashPw(b.password, s.salt)))
      return schoolFail(res, 401, 'نام کاربری یا رمز عبور درست نیست.');
    return send(res, 200, { ok: true, token: schoolNewToken(username, false), student: schoolPublic(s) });
  }

  if (req.method === 'GET' && url === '/api/school/me') {
    const s = schoolStudent(req);
    if (!s) return schoolFail(res, 401, 'وارد حساب نشدی.');
    return send(res, 200, { student: schoolPublic(s) });
  }

  if (req.method === 'POST' && url === '/api/school/progress') {
    const s = schoolStudent(req);
    if (!s) return schoolFail(res, 401, 'وارد حساب نشدی.');
    if (b.study && typeof b.study === 'object' && !Array.isArray(b.study)) {
      const study = {};
      for (const [k, v] of Object.entries(b.study).slice(0, 100)) {
        const n = Number(v);
        if (Number.isFinite(n)) study[String(k).slice(0, 30)] = Math.max(0, Math.min(100000, Math.floor(n)));
      }
      s.study = study;
    }
    if (Array.isArray(b.tasks)) s.tasks = b.tasks.slice(0, 200);
    const goal = Number(b.goal);
    if (Number.isFinite(goal)) s.goal = Math.max(1, Math.min(1440, Math.floor(goal)));
    save();
    return send(res, 200, { ok: true, student: schoolPublic(s) });
  }

  if (req.method === 'POST' && url === '/api/school/admin/login') {
    const supplied = String(b.password || '').replace(/[\s‌‍‎‏]/g, '').toUpperCase();
    if (!same(supplied, SCHOOL_ADMIN_PASSWORD)) return schoolFail(res, 401, 'رمز مدیریت درست نیست.');
    return send(res, 200, { ok: true, token: schoolNewToken('', true) });
  }

  if (req.method === 'GET' && url === '/api/school/posts') {
    if (!schoolAdmin(req) && !schoolStudent(req)) return schoolFail(res, 401, 'ابتدا وارد حساب شو.');
    return send(res, 200, { posts: db.schoolPosts });
  }
  if (req.method === 'GET' && url === '/api/school/news')
    return send(res, 200, { posts: db.schoolPosts.filter(p => p.subject === 'اطلاعیه') });

  if (req.method === 'GET' && url === '/api/school/admin/students') {
    if (!schoolAdmin(req)) return schoolFail(res, 403, 'اجازه دسترسی نداری.');
    return send(res, 200, { students: Object.values(db.schoolStudents).map(schoolPublic) });
  }

  if (req.method === 'DELETE' && url.startsWith('/api/school/admin/students/')) {
    if (!schoolAdmin(req)) return schoolFail(res, 403, 'اجازه دسترسی نداری.');
    const username = decodeURIComponent(url.slice('/api/school/admin/students/'.length)).toLowerCase();
    if (!db.schoolStudents[username]) return schoolFail(res, 404, 'دانش‌آموز پیدا نشد.');
    delete db.schoolStudents[username];
    for (const [t, u] of Object.entries(db.schoolTokens)) if (u === username) delete db.schoolTokens[t];
    save();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url === '/api/school/admin/posts') {
    if (!schoolAdmin(req)) return schoolFail(res, 403, 'اجازه دسترسی نداری.');
    const title = String(b.title || '').trim();
    const text = String(b.body || '').trim();
    const subject = String(b.subject || 'عمومی').trim().slice(0, 30);
    if (!title || !text) return schoolFail(res, 400, 'عنوان و متن مطلب را بنویسید.');
    if (title.length > 120 || text.length > 10000) return schoolFail(res, 400, 'متن مطلب بیش از حد طولانی است.');
    const post = { id: crypto.randomBytes(10).toString('hex'), subject, title, body: text, created: Date.now() };
    db.schoolPosts.unshift(post);
    db.schoolPosts = db.schoolPosts.slice(0, 300);
    save();
    return send(res, 200, { ok: true, post });
  }

  if (req.method === 'DELETE' && url.startsWith('/api/school/admin/posts/')) {
    if (!schoolAdmin(req)) return schoolFail(res, 403, 'اجازه دسترسی نداری.');
    const id = decodeURIComponent(url.slice('/api/school/admin/posts/'.length));
    const before = db.schoolPosts.length;
    db.schoolPosts = db.schoolPosts.filter(p => p.id !== id);
    if (db.schoolPosts.length === before) return schoolFail(res, 404, 'مطلب پیدا نشد.');
    save();
    return send(res, 200, { ok: true });
  }

  return schoolFail(res, 404, 'مسیر مدرسه پیدا نشد.');
}
/* ========== پایان بخش مدرسه ارجمند ========== */
