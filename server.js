const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// SQLite DB 초기화
const db = new sqlite3.Database('./lawquiz.db', (err) => {
  if (err) console.error('DB 연결 실패:', err.message);
  else console.log('SQLite DB 연결 성공: lawquiz.db');
});

db.serialize(() => {
  // 공용 문제 테이블 (모든 사용자가 같은 문제를 공유)
  db.run(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      number TEXT,
      grp TEXT,
      subject TEXT,
      categoryPath TEXT,
      category TEXT,
      type TEXT,
      text TEXT,
      choices TEXT,
      answer TEXT,
      explanation TEXT,
      incomplete INTEGER DEFAULT 0,
      sourcePages TEXT DEFAULT ''
    )
  `);

  // 기존 DB에 최종 수정자 / 수정 시각 컬럼이 없으면 추가 (기존 데이터 유지)
  db.all(`PRAGMA table_info(questions)`, [], (err, cols) => {
    if (err) return console.error(err.message);
    const names = cols.map(c => c.name);
    if (!names.includes('updated_by')) db.run(`ALTER TABLE questions ADD COLUMN updated_by TEXT DEFAULT ''`);
    if (!names.includes('updated_at')) db.run(`ALTER TABLE questions ADD COLUMN updated_at TEXT DEFAULT ''`);
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      created_at TEXT
    )
  `);

  // 로그인 세션 (토큰으로 본인 확인)
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_stats (
      username TEXT,
      question_id TEXT,
      attempts INTEGER DEFAULT 0,
      correct INTEGER DEFAULT 0,
      wrong INTEGER DEFAULT 0,
      last TEXT,
      note TEXT DEFAULT '',
      PRIMARY KEY (username, question_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_bookmarks (
      username TEXT,
      question_id TEXT,
      PRIMARY KEY (username, question_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      username TEXT PRIMARY KEY,
      settings_json TEXT
    )
  `);
});

// ---------- 비밀번호 / 세션 ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt$')) return pw === stored; // 예전 평문 비밀번호 호환
  const [, salt, hash] = stored.split('$');
  const test = crypto.scryptSync(pw, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return orig.length === test.length && crypto.timingSafeEqual(orig, test);
}

// 토큰이 있으면 req.user 설정 (없어도 통과)
function optionalAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next();
  db.get(`SELECT username FROM sessions WHERE token = ?`, [token], (err, row) => {
    if (row) req.user = row.username;
    next();
  });
}
// 로그인 필수
function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다. 다시 로그인해 주세요.' });
    next();
  });
}

function rowToQuestion(r) {
  return {
    id: r.id,
    number: r.number,
    group: r.grp,
    subject: r.subject,
    categoryPath: r.categoryPath ? JSON.parse(r.categoryPath) : ['기본단원'],
    category: r.category,
    type: r.type,
    text: r.text,
    choices: r.choices ? JSON.parse(r.choices) : [],
    answer: r.answer,
    explanation: r.explanation,
    incomplete: Boolean(r.incomplete),
    sourcePages: r.sourcePages,
    updatedBy: r.updated_by || '',
    updatedAt: r.updated_at || ''
  };
}

// 1. 공용 문제 + (로그인 시) 본인 학습 데이터 로드
app.get('/api/bootstrap', optionalAuth, (req, res) => {
  const username = req.user;

  db.all(`SELECT * FROM questions ORDER BY CAST(number AS INTEGER) ASC`, [], (err, qRows) => {
    if (err) return res.status(500).json({ error: err.message });
    const bank = qRows.map(rowToQuestion);

    if (!username) {
      return res.json({ bank, user: null, stats: {}, bookmarks: [], notes: {}, settings: { lastSubject: null, lastIndex: {}, lastId: {} } });
    }

    db.all(`SELECT * FROM user_stats WHERE username = ?`, [username], (err, sRows) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(`SELECT question_id FROM user_bookmarks WHERE username = ?`, [username], (err, bRows) => {
        if (err) return res.status(500).json({ error: err.message });
        db.get(`SELECT settings_json FROM user_settings WHERE username = ?`, [username], (err, setRow) => {
          if (err) return res.status(500).json({ error: err.message });

          const stats = {};
          const notes = {};
          (sRows || []).forEach(s => {
            stats[s.question_id] = { attempts: s.attempts, correct: s.correct, wrong: s.wrong, last: s.last };
            if (s.note) notes[s.question_id] = s.note;
          });
          const bookmarks = (bRows || []).map(b => b.question_id);
          let settings = { lastSubject: null, lastIndex: {}, lastId: {} };
          if (setRow && setRow.settings_json) {
            try { settings = JSON.parse(setRow.settings_json); } catch (e) {}
          }
          res.json({ bank, user: username, stats, bookmarks, notes, settings });
        });
      });
    });
  });
});

// 2. 로그인 / 회원가입 (자동 등록) → 세션 토큰 발급
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '이름과 비밀번호를 모두 입력하세요.' });

  const issueToken = (isNew) => {
    const token = crypto.randomBytes(32).toString('hex');
    db.run(`INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)`,
      [token, username, new Date().toISOString()], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, isNew, username, token });
      });
  };

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) {
      db.run(`INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)`,
        [username, hashPassword(password), new Date().toISOString()], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          issueToken(true);
        });
    } else {
      if (!verifyPassword(password, row.password)) {
        return res.status(401).json({ error: '비밀번호가 일치하지 않습니다.' });
      }
      // 평문으로 저장돼 있던 예전 비밀번호는 이 기회에 암호화해서 다시 저장
      if (!row.password.startsWith('scrypt$')) {
        db.run(`UPDATE users SET password = ? WHERE username = ?`, [hashPassword(password), username]);
      }
      issueToken(false);
    }
  });
});

// 로그아웃 (토큰 폐기)
app.post('/api/auth/logout', (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.json({ success: true });
  db.run(`DELETE FROM sessions WHERE token = ?`, [token], () => res.json({ success: true }));
});

// 3-1. 문제 새로 등록 (로그인 필수)
app.post('/api/question', requireAuth, (req, res) => {
  const q = req.body;
  const now = new Date().toISOString();
  const sql = `
    INSERT OR REPLACE INTO questions (id, number, grp, subject, categoryPath, category, type, text, choices, answer, explanation, incomplete, sourcePages, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    q.id, q.number || '1', q.group || '', q.subject || '',
    JSON.stringify(q.categoryPath || ['기본단원']), q.category || '',
    q.type || 'ox', q.text || '', JSON.stringify(q.choices || []),
    q.answer || '', q.explanation || '', q.incomplete ? 1 : 0, q.sourcePages || '',
    req.user, now
  ];
  db.run(sql, params, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updatedBy: req.user, updatedAt: now });
  });
});

// 3-2. 문제 수정 (로그인 필수, 공용 DB의 해당 문제를 직접 수정, 최종 수정자 기록)
app.put('/api/question/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const q = req.body || {};
  const now = new Date().toISOString();

  db.get(`SELECT * FROM questions WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: '이미 삭제되었거나 존재하지 않는 문제입니다.' });

    const text = q.text !== undefined ? String(q.text) : row.text;
    const answer = q.answer !== undefined ? String(q.answer) : row.answer;
    const explanation = q.explanation !== undefined ? String(q.explanation) : row.explanation;
    const choices = Array.isArray(q.choices) ? JSON.stringify(q.choices) : row.choices;

    db.run(
      `UPDATE questions SET text = ?, answer = ?, explanation = ?, choices = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [text, answer, explanation, choices, req.user, now, id],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.get(`SELECT * FROM questions WHERE id = ?`, [id], (err, updated) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, question: rowToQuestion(updated) });
        });
      }
    );
  });
});

// 4. 문제 삭제 (로그인 필수)
app.delete('/api/question/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM questions WHERE id = ?`, [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run(`DELETE FROM user_stats WHERE question_id = ?`, [id]);
    db.run(`DELETE FROM user_bookmarks WHERE question_id = ?`, [id]);
    res.json({ success: true });
  });
});

// 5. 풀이 통계 업데이트 (토큰의 본인 계정에만 기록)
app.post('/api/stats', requireAuth, (req, res) => {
  const username = req.user;
  const { id, isCorrect, settings } = req.body;
  const now = new Date().toISOString();
  const incC = isCorrect ? 1 : 0;
  const incW = isCorrect ? 0 : 1;

  const sql = `
    INSERT INTO user_stats (username, question_id, attempts, correct, wrong, last)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(username, question_id) DO UPDATE SET
      attempts = attempts + 1,
      correct = correct + ?,
      wrong = wrong + ?,
      last = ?
  `;
  db.run(sql, [username, id, incC, incW, now, incC, incW, now], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (settings) {
      db.run(`INSERT OR REPLACE INTO user_settings (username, settings_json) VALUES (?, ?)`,
        [username, JSON.stringify(settings)]);
    }
    res.json({ success: true });
  });
});

// 6. 북마크 토글
app.post('/api/bookmark', requireAuth, (req, res) => {
  const username = req.user;
  const { id, isBookmarked } = req.body;
  const sql = isBookmarked
    ? `INSERT OR IGNORE INTO user_bookmarks (username, question_id) VALUES (?, ?)`
    : `DELETE FROM user_bookmarks WHERE username = ? AND question_id = ?`;
  db.run(sql, [username, id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 7. 메모 저장
app.post('/api/note', requireAuth, (req, res) => {
  const username = req.user;
  const { id, note } = req.body;
  const sql = `
    INSERT INTO user_stats (username, question_id, note) VALUES (?, ?, ?)
    ON CONFLICT(username, question_id) DO UPDATE SET note = ?
  `;
  db.run(sql, [username, id, note, note], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 8. JSON 일괄 병합 (로그인 필수, 업로드한 사람을 최종 수정자로 기록)
app.post('/api/import', requireAuth, (req, res) => {
  const { questions } = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions array required' });
  const now = new Date().toISOString();

  db.serialize(() => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO questions (id, number, grp, subject, categoryPath, category, type, text, choices, answer, explanation, incomplete, sourcePages, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    questions.forEach((q, i) => {
      stmt.run([
        String(q.id || `import-${Date.now()}-${i}`),
        String(q.number || i + 1),
        q.group || '',
        q.subject || '',
        JSON.stringify(q.categoryPath || ['기본단원']),
        q.category || '기본단원',
        q.type === 'ox' ? 'ox' : 'mcq',
        q.text || '',
        JSON.stringify(q.choices || []),
        q.answer || '',
        q.explanation || '',
        q.incomplete ? 1 : 0,
        q.sourcePages || '',
        req.user,
        now
      ]);
    });
    stmt.finalize((err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, count: questions.length });
    });
  });
});

// 9. 학습기록 초기화 — 토큰의 본인 계정 기록만 삭제
app.post('/api/reset-progress', requireAuth, (req, res) => {
  const username = req.user;
  db.serialize(() => {
    db.run(`DELETE FROM user_stats WHERE username = ?`, [username]);
    db.run(`DELETE FROM user_bookmarks WHERE username = ?`, [username]);
    db.run(`DELETE FROM user_settings WHERE username = ?`, [username], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LAW QUIZ 서버 가동 중: 포트 ${PORT}`);
});
