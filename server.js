const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

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
  // 공용 문제 테이블
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

  // 사용자 계정 테이블
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      created_at TEXT
    )
  `);

  // 사용자별 통계 및 메모
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

  // 사용자별 북마크
  db.run(`
    CREATE TABLE IF NOT EXISTS user_bookmarks (
      username TEXT,
      question_id TEXT,
      PRIMARY KEY (username, question_id)
    )
  `);

  // 사용자별 설정
  db.run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      username TEXT PRIMARY KEY,
      settings_json TEXT
    )
  `);
});

// 1. 공용 문제 데이터 및 사용자 데이터 로드
app.get('/api/bootstrap', (req, res) => {
  const username = req.query.username;

  db.all(`SELECT * FROM questions ORDER BY CAST(number AS INTEGER) ASC`, [], (err, qRows) => {
    if (err) return res.status(500).json({ error: err.message });

    const bank = qRows.map(r => ({
      id: r.id,
      number: r.number,
      group: r.grp,
      subject: r.subject,
      categoryPath: r.categoryPath ? JSON.parse(r.categoryPath) : ["기본단원"],
      category: r.category,
      type: r.type,
      text: r.text,
      choices: r.choices ? JSON.parse(r.choices) : [],
      answer: r.answer,
      explanation: r.explanation,
      incomplete: Boolean(r.incomplete),
      sourcePages: r.sourcePages
    }));

    // 비로그인 상태일 때는 빈 통계 반환
    if (!username) {
      return res.json({ bank, stats: {}, bookmarks: [], notes: {}, settings: { lastSubject: null, lastIndex: {}, lastId: {} } });
    }

    // 로그인된 사용자의 데이터 로드
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
            try { settings = JSON.parse(setRow.settings_json); } catch(e) {}
          }

          res.json({ bank, stats, bookmarks, notes, settings });
        });
      });
    });
  });
});

// 2. 로그인 / 회원가입 (자동 등록)
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "이름과 비밀번호를 모두 입력하세요." });

  db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) {
      // 신규 계정 자동 생성
      const now = new Date().toISOString();
      db.run(`INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)`, [username, password, now], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        return res.json({ success: true, isNew: true, username });
      });
    } else {
      if (row.password !== password) {
        return res.status(401).json({ error: "비밀번호가 일치하지 않습니다." });
      }
      return res.json({ success: true, isNew: false, username });
    }
  });
});

// 3. 문제 등록/수정
app.post('/api/question', (req, res) => {
  const q = req.body;
  const sql = `
    INSERT OR REPLACE INTO questions (id, number, grp, subject, categoryPath, category, type, text, choices, answer, explanation, incomplete, sourcePages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    q.id,
    q.number || '1',
    q.group || '',
    q.subject || '',
    JSON.stringify(q.categoryPath || ['기본단원']),
    q.category || '',
    q.type || 'ox',
    q.text || '',
    JSON.stringify(q.choices || []),
    q.answer || '',
    q.explanation || '',
    q.incomplete ? 1 : 0,
    q.sourcePages || ''
  ];
  db.run(sql, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 4. 문제 삭제
app.delete('/api/question/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM questions WHERE id = ?`, [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run(`DELETE FROM user_stats WHERE question_id = ?`, [id]);
    db.run(`DELETE FROM user_bookmarks WHERE question_id = ?`, [id]);
    res.json({ success: true });
  });
});

// 5. 풀이 통계 업데이트 (로그인 사용자 전용)
app.post('/api/stats', (req, res) => {
  const { username, id, isCorrect, settings } = req.body;
  if (!username) return res.json({ success: false, reason: "비로그인 상태" });

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
      db.run(
        `INSERT OR REPLACE INTO user_settings (username, settings_json) VALUES (?, ?)`,
        [username, JSON.stringify(settings)]
      );
    }
    res.json({ success: true });
  });
});

// 6. 북마크 토글
app.post('/api/bookmark', (req, res) => {
  const { username, id, isBookmarked } = req.body;
  if (!username) return res.json({ success: false, reason: "비로그인 상태" });

  if (isBookmarked) {
    db.run(`INSERT OR IGNORE INTO user_bookmarks (username, question_id) VALUES (?, ?)`, [username, id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  } else {
    db.run(`DELETE FROM user_bookmarks WHERE username = ? AND question_id = ?`, [username, id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  }
});

// 7. 메모 저장
app.post('/api/note', (req, res) => {
  const { username, id, note } = req.body;
  if (!username) return res.json({ success: false, reason: "비로그인 상태" });

  const sql = `
    INSERT INTO user_stats (username, question_id, note) VALUES (?, ?, ?)
    ON CONFLICT(username, question_id) DO UPDATE SET note = ?
  `;
  db.run(sql, [username, id, note, note], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 8. JSON 일괄 병합/덮어쓰기
app.post('/api/import', (req, res) => {
  const { questions, mode } = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions array required' });

  db.serialize(() => {
    if (mode === 'replace') {
      db.run(`DELETE FROM questions`);
      db.run(`DELETE FROM user_stats`);
      db.run(`DELETE FROM user_bookmarks`);
    }

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO questions (id, number, grp, subject, categoryPath, category, type, text, choices, answer, explanation, incomplete, sourcePages)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        q.sourcePages || ''
      ]);
    });

    stmt.finalize((err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, count: questions.length });
    });
  });
});

// 9. 사용자별 학습기록 리셋
app.post('/api/reset-progress', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "로그인이 필요합니다." });

  db.serialize(() => {
    db.run(`DELETE FROM user_stats WHERE username = ?`, [username]);
    db.run(`DELETE FROM user_bookmarks WHERE username = ?`, [username]);
    db.run(`DELETE FROM user_settings WHERE username = ?`, [username]);
    res.json({ success: true });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LAW QUIZ 서버 가동 중: 포트 ${PORT}`);
});
