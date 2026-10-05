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
  // 문제 테이블
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

  // 문제별 풀이 통계 및 메모
  db.run(`
    CREATE TABLE IF NOT EXISTS stats (
      id TEXT PRIMARY KEY,
      attempts INTEGER DEFAULT 0,
      correct INTEGER DEFAULT 0,
      wrong INTEGER DEFAULT 0,
      last TEXT,
      note TEXT DEFAULT ''
    )
  `);

  // 북마크
  db.run(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY
    )
  `);

  // 시스템 설정 및 진행 상태
  db.run(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
});

// 1. 전체 데이터 로드
app.get('/api/bootstrap', (req, res) => {
  db.all(`SELECT * FROM questions ORDER BY CAST(number AS INTEGER) ASC`, [], (err, qRows) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all(`SELECT * FROM stats`, [], (err, sRows) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(`SELECT id FROM bookmarks`, [], (err, bRows) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all(`SELECT * FROM app_state`, [], (err, stateRows) => {
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

          const stats = {};
          const notes = {};
          sRows.forEach(s => {
            stats[s.id] = { attempts: s.attempts, correct: s.correct, wrong: s.wrong, last: s.last };
            if (s.note) notes[s.id] = s.note;
          });

          const bookmarks = bRows.map(b => b.id);
          
          let settings = { lastSubject: null, lastIndex: {}, lastId: {} };
          const settingRow = stateRows.find(r => r.key === 'settings');
          if (settingRow) {
            try { settings = JSON.parse(settingRow.value); } catch(e) {}
          }

          res.json({ bank, stats, bookmarks, notes, settings });
        });
      });
    });
  });
});

// 2. 단일 문제 저장/추가/수정
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

// 3. 문제 삭제
app.delete('/api/question/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM questions WHERE id = ?`, [id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run(`DELETE FROM stats WHERE id = ?`, [id]);
    db.run(`DELETE FROM bookmarks WHERE id = ?`, [id]);
    res.json({ success: true });
  });
});

// 4. 풀이 통계 및 학습기록 업데이트
app.post('/api/stats', (req, res) => {
  const { id, isCorrect, settings } = req.body;
  const now = new Date().toISOString();
  const incC = isCorrect ? 1 : 0;
  const incW = isCorrect ? 0 : 1;

  const sql = `
    INSERT INTO stats (id, attempts, correct, wrong, last)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      attempts = attempts + 1,
      correct = correct + ?,
      wrong = wrong + ?,
      last = ?
  `;
  db.run(sql, [id, incC, incW, now, incC, incW, now], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (settings) {
      db.run(
        `INSERT OR REPLACE INTO app_state (key, value) VALUES ('settings', ?)`,
        [JSON.stringify(settings)]
      );
    }
    res.json({ success: true });
  });
});

// 5. 북마크 토글
app.post('/api/bookmark', (req, res) => {
  const { id, isBookmarked } = req.body;
  if (isBookmarked) {
    db.run(`INSERT OR IGNORE INTO bookmarks (id) VALUES (?)`, [id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  } else {
    db.run(`DELETE FROM bookmarks WHERE id = ?`, [id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  }
});

// 6. 메모 업데이트
app.post('/api/note', (req, res) => {
  const { id, note } = req.body;
  const sql = `
    INSERT INTO stats (id, note) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET note = ?
  `;
  db.run(sql, [id, note, note], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 7. JSON 일괄 병합/덮어쓰기
app.post('/api/import', (req, res) => {
  const { questions, mode } = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions array required' });

  db.serialize(() => {
    if (mode === 'replace') {
      db.run(`DELETE FROM questions`);
      db.run(`DELETE FROM stats`);
      db.run(`DELETE FROM bookmarks`);
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

// 8. 학습기록 리셋
app.post('/api/reset-progress', (req, res) => {
  db.serialize(() => {
    db.run(`DELETE FROM stats`);
    db.run(`DELETE FROM bookmarks`);
    db.run(`DELETE FROM app_state WHERE key = 'settings'`);
    res.json({ success: true });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LAW QUIZ 서버 가동 중: 포트 ${PORT}`);
});