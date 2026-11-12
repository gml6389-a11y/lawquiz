const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Postgres 연결 (Render 환경변수 DATABASE_URL, Neon 접속 주소) ----------
const RAW_URL = (process.env.DATABASE_URL || '').trim();
if (!RAW_URL) {
  console.error('❌ DATABASE_URL 환경변수가 없습니다. Render 서비스 설정 > Environment 에 Neon 접속 주소를 넣어 주세요.');
}
// 외부 DB(Neon 등)는 SSL 필요. 접속 주소에 붙은 sslmode·channel_binding 옵션은 떼고 SSL은 아래에서 직접 설정한다
const needSsl = /neon\.tech|\.render\.com|supabase\.co|sslmode=/.test(RAW_URL);
let DATABASE_URL = RAW_URL;
try {
  const u = new URL(RAW_URL);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('channel_binding');
  DATABASE_URL = u.toString();
} catch (e) { /* 형식이 특이하면 원래 주소 사용 */ }
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needSsl ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000   // Neon이 잠들어 있다 깨어나는 시간 고려
});
pool.on('error', err => console.error('DB 연결 오류(자동 재연결):', err.message));
const q = (sql, params = []) => pool.query(sql, params);

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      number TEXT,
      grp TEXT,
      subject TEXT,
      categorypath TEXT,
      category TEXT,
      type TEXT,
      text TEXT,
      choices TEXT,
      answer TEXT,
      explanation TEXT,
      incomplete INTEGER DEFAULT 0,
      sourcepages TEXT DEFAULT '',
      updated_by TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      meta TEXT DEFAULT ''
    )`);
  await q(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT NOT NULL, created_at TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at TEXT)`);
  await q(`
    CREATE TABLE IF NOT EXISTS user_stats (
      username TEXT,
      question_id TEXT,
      attempts INTEGER DEFAULT 0,
      correct INTEGER DEFAULT 0,
      wrong INTEGER DEFAULT 0,
      last TEXT,
      note TEXT DEFAULT '',
      streak INTEGER DEFAULT 0,
      PRIMARY KEY (username, question_id)
    )`);
  await q(`CREATE TABLE IF NOT EXISTS user_bookmarks (username TEXT, question_id TEXT, PRIMARY KEY (username, question_id))`);
  await q(`CREATE TABLE IF NOT EXISTS user_settings (username TEXT PRIMARY KEY, settings_json TEXT)`);
  // 계정별 날짜(한국시간)별 풀이 집계
  await q(`CREATE TABLE IF NOT EXISTS user_daily (username TEXT, day TEXT, attempts INTEGER DEFAULT 0, correct INTEGER DEFAULT 0, PRIMARY KEY (username, day))`);
  // 계정 생성 기록
  await q(`CREATE TABLE IF NOT EXISTS account_log (id SERIAL PRIMARY KEY, username TEXT, created_at TEXT, ip TEXT, user_agent TEXT)`);
  // 기본 문제 데이터 반영 기록
  await q(`CREATE TABLE IF NOT EXISTS seed_rows (id TEXT PRIMARY KEY, seeded_at TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);
  console.log('Postgres 연결 및 테이블 준비 완료');
}

// ---------- 기본 문제 데이터 자동 반영 ----------
// data/sangbeop2026.json 의 문제를 서버 시작 시 DB에 반영한다.
// - 처음 보는 문제: 추가
// - 이미 반영된 문제: 사이트에서 수정하지 않았다면 새 데이터로 갱신, 수정했다면 유지, 사이트에서 삭제했다면 다시 넣지 않음
const DATA_FILE = path.join(__dirname, 'data', 'sangbeop2026.json');
const SEED_USER = 'system';
let appInfo = { title: '상법짱2026', exams: [], categoryOrder: [], version: '' };

const QCOLS = ['id', 'number', 'grp', 'subject', 'categorypath', 'category', 'type', 'text', 'choices', 'answer', 'explanation', 'incomplete', 'sourcepages', 'updated_by', 'updated_at', 'meta'];
const UPSERT_TAIL = `ON CONFLICT (id) DO UPDATE SET ${QCOLS.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ')}`;

async function upsertQuestions(rows) {
  // rows: 배열의 배열 (QCOLS 순서)
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params = [];
    const values = chunk.map((r, j) => {
      r.forEach(v => params.push(v));
      return '(' + r.map((_, k) => `$${j * QCOLS.length + k + 1}`).join(',') + ')';
    });
    await q(`INSERT INTO questions (${QCOLS.join(',')}) VALUES ${values.join(',')} ${UPSERT_TAIL}`, params);
  }
}

async function seedQuestions() {
  let data;
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return console.error('문제 데이터 파일을 읽지 못했습니다:', DATA_FILE, e.message); }
  appInfo = { title: data.title || '상법짱2026', exams: data.exams || [], categoryOrder: data.categoryOrder || [], version: data.version || '' };

  const cur = await q(`SELECT value FROM app_meta WHERE key = 'data_version'`);
  if (cur.rows[0] && cur.rows[0].value === data.version) {
    return console.log(`문제 데이터 최신 상태 (버전 ${data.version}, ${data.questions.length}문제)`);
  }
  const seededRows = await q(`SELECT s.id, qq.updated_by FROM seed_rows s LEFT JOIN questions qq ON qq.id = s.id`);
  const seeded = new Map(seededRows.rows.map(r => [r.id, r.updated_by]));
  const now = new Date().toISOString();
  const rows = []; const ids = [];
  let added = 0, updated = 0, kept = 0;
  for (const x of data.questions) {
    if (seeded.has(x.id)) {
      const by = seeded.get(x.id);
      if (by === null || by === undefined) { kept++; continue; } // 사이트에서 삭제한 문제
      if (by !== SEED_USER) { kept++; continue; }                 // 사이트에서 수정한 문제
      updated++;
    } else added++;
    rows.push([x.id, x.number, x.group, x.subject, JSON.stringify(x.categoryPath), x.category, x.type, x.text,
      JSON.stringify(x.choices || []), x.answer, x.explanation, 0, x.sourcePages || '', SEED_USER, now, JSON.stringify(x.meta || {})]);
    ids.push(x.id);
  }
  await upsertQuestions(rows);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await q(`INSERT INTO seed_rows (id, seeded_at) SELECT unnest($1::text[]), $2 ON CONFLICT (id) DO UPDATE SET seeded_at = EXCLUDED.seeded_at`, [chunk, now]);
  }
  await q(`INSERT INTO app_meta (key, value) VALUES ('data_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [data.version]);
  console.log(`문제 데이터 반영 완료: 추가 ${added} / 갱신 ${updated} / 사이트 수정·삭제본 유지 ${kept}`);
}

// ---------- 도우미 ----------
function kstDay(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function sendJson(req, res, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  if (body.length > 20000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    zlib.gzip(body, (err, gz) => {
      if (err) return res.json(obj);
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      res.send(gz);
    });
  } else res.json(obj);
}
// async 라우트 오류를 500으로 응답
const wrap = fn => (req, res, next) => fn(req, res, next).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message || '서버 오류' });
});

// ---------- 비밀번호 / 세션 ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt$')) return pw === stored;
  const [, salt, hash] = stored.split('$');
  const test = crypto.scryptSync(pw, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return orig.length === test.length && crypto.timingSafeEqual(orig, test);
}
async function optionalAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (token) {
      const r = await q(`SELECT username FROM sessions WHERE token = $1`, [token]);
      if (r.rows[0]) req.user = r.rows[0].username;
    }
  } catch (e) { console.error(e.message); }
  next();
}
function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다. 다시 로그인해 주세요.' });
    next();
  });
}

function rowToQuestion(r) {
  let meta = {};
  if (r.meta) { try { meta = JSON.parse(r.meta); } catch (e) {} }
  const sys = !r.updated_by || r.updated_by === SEED_USER;
  return {
    id: r.id,
    number: r.number,
    group: r.grp,
    subject: r.subject,
    categoryPath: r.categorypath ? JSON.parse(r.categorypath) : ['기본단원'],
    category: r.category,
    type: r.type,
    text: r.text,
    choices: r.choices ? JSON.parse(r.choices) : [],
    answer: r.answer,
    explanation: r.explanation,
    incomplete: Boolean(r.incomplete),
    sourcePages: r.sourcepages,
    updatedBy: sys ? '' : r.updated_by,
    updatedAt: sys ? '' : (r.updated_at || ''),
    meta
  };
}

// 1. 공용 문제 + (로그인 시) 본인 학습 데이터 로드
app.get('/api/bootstrap', optionalAuth, wrap(async (req, res) => {
  const username = req.user;
  const qr = await q(`SELECT * FROM questions ORDER BY (CASE WHEN number ~ '^[0-9]+$' THEN number::bigint ELSE 0 END) ASC, id ASC`);
  const bank = qr.rows.map(rowToQuestion);
  const emptySettings = { lastSubject: null, lastIndex: {}, lastId: {} };
  if (!username) {
    return sendJson(req, res, { app: appInfo, bank, user: null, stats: {}, bookmarks: [], notes: {}, settings: emptySettings });
  }
  const [sr, br, setr] = await Promise.all([
    q(`SELECT * FROM user_stats WHERE username = $1`, [username]),
    q(`SELECT question_id FROM user_bookmarks WHERE username = $1`, [username]),
    q(`SELECT settings_json FROM user_settings WHERE username = $1`, [username])
  ]);
  const stats = {}, notes = {};
  sr.rows.forEach(s => {
    stats[s.question_id] = { attempts: s.attempts, correct: s.correct, wrong: s.wrong, last: s.last, streak: s.streak || 0 };
    if (s.note) notes[s.question_id] = s.note;
  });
  const bookmarks = br.rows.map(b => b.question_id);
  let settings = emptySettings;
  if (setr.rows[0] && setr.rows[0].settings_json) { try { settings = JSON.parse(setr.rows[0].settings_json); } catch (e) {} }
  sendJson(req, res, { app: appInfo, bank, user: username, stats, bookmarks, notes, settings });
}));

// 2-1. 계정 생성 (이미 있는 아이디면 거절, 생성 기록 저장)
async function issueToken(res, username, isNew) {
  const token = crypto.randomBytes(32).toString('hex');
  await q(`INSERT INTO sessions (token, username, created_at) VALUES ($1, $2, $3)`, [token, username, new Date().toISOString()]);
  res.json({ success: true, isNew, username, token });
}

app.post('/api/auth/register', wrap(async (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!username || !password) return res.status(400).json({ error: '닉네임과 비밀번호를 모두 입력하세요.' });
  if (username.length > 20) return res.status(400).json({ error: '닉네임은 20자 이내로 입력하세요.' });
  if (!/^\d{6}$/.test(password)) return res.status(400).json({ error: '비밀번호는 숫자 6자리로 입력하세요.' });
  const now = new Date().toISOString();
  const ins = await q(`INSERT INTO users (username, password, created_at) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING`,
    [username, hashPassword(password), now]);
  if (ins.rowCount === 0) return res.status(409).json({ error: '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력하세요.' });
  await q(`INSERT INTO account_log (username, created_at, ip, user_agent) VALUES ($1, $2, $3, $4)`,
    [username, now, String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || ''), String(req.headers['user-agent'] || '')]);
  await issueToken(res, username, true);
}));

// 2-2. 로그인 (등록된 계정만)
app.post('/api/auth/login', wrap(async (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');
  if (!username || !password) return res.status(400).json({ error: '닉네임과 비밀번호를 모두 입력하세요.' });
  const r = await q(`SELECT * FROM users WHERE username = $1`, [username]);
  const row = r.rows[0];
  if (!row) return res.status(401).json({ error: '등록되지 않은 닉네임입니다. 먼저 계정을 만드세요.' });
  if (!verifyPassword(password, row.password)) return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });
  if (!row.password.startsWith('scrypt$')) await q(`UPDATE users SET password = $1 WHERE username = $2`, [hashPassword(password), username]);
  await issueToken(res, username, false);
}));

// 로그아웃 (토큰 폐기)
app.post('/api/auth/logout', wrap(async (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) await q(`DELETE FROM sessions WHERE token = $1`, [token]);
  res.json({ success: true });
}));

// 3-1. 문제 새로 등록 (로그인 필수)
app.post('/api/question', requireAuth, wrap(async (req, res) => {
  const x = req.body || {};
  const now = new Date().toISOString();
  await upsertQuestions([[
    String(x.id), x.number || '1', x.group || '', x.subject || '',
    JSON.stringify(x.categoryPath || ['기본단원']), x.category || '',
    x.type || 'ox', x.text || '', JSON.stringify(x.choices || []),
    x.answer || '', x.explanation || '', x.incomplete ? 1 : 0, x.sourcePages || '',
    req.user, now, JSON.stringify(x.meta || {})
  ]]);
  res.json({ success: true, updatedBy: req.user, updatedAt: now });
}));

// 3-2. 문제 수정 (로그인 필수, 최종 수정자 기록)
app.put('/api/question/:id', requireAuth, wrap(async (req, res) => {
  const { id } = req.params;
  const x = req.body || {};
  const now = new Date().toISOString();
  const r = await q(`SELECT * FROM questions WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: '이미 삭제되었거나 존재하지 않는 문제입니다.' });
  const text = x.text !== undefined ? String(x.text) : row.text;
  const answer = x.answer !== undefined ? String(x.answer) : row.answer;
  const explanation = x.explanation !== undefined ? String(x.explanation) : row.explanation;
  const choices = Array.isArray(x.choices) ? JSON.stringify(x.choices) : row.choices;
  const u = await q(`UPDATE questions SET text = $1, answer = $2, explanation = $3, choices = $4, updated_by = $5, updated_at = $6 WHERE id = $7 RETURNING *`,
    [text, answer, explanation, choices, req.user, now, id]);
  res.json({ success: true, question: rowToQuestion(u.rows[0]) });
}));

// 4. 문제 삭제 (로그인 필수)
app.delete('/api/question/:id', requireAuth, wrap(async (req, res) => {
  const { id } = req.params;
  await q(`DELETE FROM questions WHERE id = $1`, [id]);
  await q(`DELETE FROM user_stats WHERE question_id = $1`, [id]);
  await q(`DELETE FROM user_bookmarks WHERE question_id = $1`, [id]);
  res.json({ success: true });
}));

// 5. 풀이 통계 업데이트 (본인 계정, 연속 정답·날짜별 집계 포함)
app.post('/api/stats', requireAuth, wrap(async (req, res) => {
  const username = req.user;
  const { id, isCorrect, settings } = req.body || {};
  const now = new Date().toISOString();
  const c = isCorrect ? 1 : 0, w = isCorrect ? 0 : 1;
  await q(`
    INSERT INTO user_stats (username, question_id, attempts, correct, wrong, last, streak)
    VALUES ($1, $2, 1, $3, $4, $5, $3)
    ON CONFLICT (username, question_id) DO UPDATE SET
      attempts = user_stats.attempts + 1,
      correct = user_stats.correct + $3,
      wrong = user_stats.wrong + $4,
      last = $5,
      streak = CASE WHEN $3 = 1 THEN COALESCE(user_stats.streak, 0) + 1 ELSE 0 END`,
    [username, String(id), c, w, now]);
  await q(`
    INSERT INTO user_daily (username, day, attempts, correct) VALUES ($1, $2, 1, $3)
    ON CONFLICT (username, day) DO UPDATE SET attempts = user_daily.attempts + 1, correct = user_daily.correct + $3`,
    [username, kstDay(), c]);
  if (settings) {
    await q(`INSERT INTO user_settings (username, settings_json) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET settings_json = EXCLUDED.settings_json`,
      [username, JSON.stringify(settings)]);
  }
  res.json({ success: true });
}));

// 5-1. 설정 저장 (오답 졸업 기준 등)
app.post('/api/settings', requireAuth, wrap(async (req, res) => {
  const settings = (req.body || {}).settings;
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings 필요' });
  await q(`INSERT INTO user_settings (username, settings_json) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET settings_json = EXCLUDED.settings_json`,
    [req.user, JSON.stringify(settings)]);
  res.json({ success: true });
}));

// 5-2. 날짜별 풀이 수·정답률 (본인 계정)
app.get('/api/daily', requireAuth, wrap(async (req, res) => {
  const r = await q(`SELECT day, attempts, correct FROM user_daily WHERE username = $1 ORDER BY day DESC LIMIT 60`, [req.user]);
  res.json({ today: kstDay(), days: r.rows });
}));

// 6. 북마크 토글
app.post('/api/bookmark', requireAuth, wrap(async (req, res) => {
  const { id, isBookmarked } = req.body || {};
  if (isBookmarked) await q(`INSERT INTO user_bookmarks (username, question_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.user, String(id)]);
  else await q(`DELETE FROM user_bookmarks WHERE username = $1 AND question_id = $2`, [req.user, String(id)]);
  res.json({ success: true });
}));

// 7. 메모 저장
app.post('/api/note', requireAuth, wrap(async (req, res) => {
  const { id, note } = req.body || {};
  await q(`INSERT INTO user_stats (username, question_id, note) VALUES ($1, $2, $3)
           ON CONFLICT (username, question_id) DO UPDATE SET note = EXCLUDED.note`, [req.user, String(id), String(note || '')]);
  res.json({ success: true });
}));

// 8. JSON 일괄 병합 (로그인 필수)
app.post('/api/import', requireAuth, wrap(async (req, res) => {
  const { questions } = req.body || {};
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions array required' });
  const now = new Date().toISOString();
  const rows = questions.map((x, i) => [
    String(x.id || `import-${Date.now()}-${i}`), String(x.number || i + 1), x.group || '', x.subject || '',
    JSON.stringify(x.categoryPath || ['기본단원']), x.category || '기본단원',
    x.type === 'ox' ? 'ox' : 'mcq', x.text || '', JSON.stringify(x.choices || []),
    x.answer || '', x.explanation || '', x.incomplete ? 1 : 0, x.sourcePages || '', req.user, now, JSON.stringify(x.meta || {})
  ]);
  await upsertQuestions(rows);
  res.json({ success: true, count: questions.length });
}));

// 9. 학습기록 초기화 (본인 계정만)
app.post('/api/reset-progress', requireAuth, wrap(async (req, res) => {
  const u = req.user;
  await q(`DELETE FROM user_stats WHERE username = $1`, [u]);
  await q(`DELETE FROM user_bookmarks WHERE username = $1`, [u]);
  await q(`DELETE FROM user_daily WHERE username = $1`, [u]);
  await q(`DELETE FROM user_settings WHERE username = $1`, [u]);
  res.json({ success: true });
}));

// ---------- 시작 ----------
(async () => {
  try {
    await initDb();
    await seedQuestions();
  } catch (e) {
    console.error('DB 초기화 실패:', e.message);
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`상법짱2026 서버 가동 중: 포트 ${PORT}`));
})();
