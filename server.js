const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// SQLite 데이터베이스 연결
const db = new sqlite3.Database('./lawquiz.db', (err) => {
  if (err) console.error('DB 연결 실패:', err.message);
  else console.log('SQLite DB 연결 성공: lawquiz.db');
});

// 테이블 초기화
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      number TEXT,
      grp TEXT,
      subject TEXT,
      category TEXT,
      type TEXT,
      text TEXT,
      choices TEXT,
      answer TEXT,
      explanation TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_progress (
      question_id TEXT PRIMARY KEY,
      attempts INTEGER DEFAULT 0,
      correct INTEGER DEFAULT 0,
      wrong INTEGER DEFAULT 0,
      bookmarked INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      last_attempt TEXT
    )
  `);
});

// 1. 전체 문제 및 풀이 기록 조회 (통합)
app.get('/api/questions', (req, res) => {
  const query = `
    SELECT 
      q.id, q.number, q.grp as "group", q.subject, q.category, 
      q.type, q.text, q.choices, q.answer, q.explanation,
      COALESCE(p.attempts, 0) as attempts,
      COALESCE(p.correct, 0) as correct,
      COALESCE(p.wrong, 0) as wrong,
      COALESCE(p.bookmarked, 0) as bookmarked,
      COALESCE(p.note, '') as note
    FROM questions q
    LEFT JOIN user_progress p ON q.id = p.question_id
    ORDER BY CAST(q.number AS INTEGER) ASC
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const formatted = rows.map(r => ({
      ...r,
      choices: r.choices ? JSON.parse(r.choices) : [],
      categoryPath: r.category ? r.category.split('>').map(s => s.trim()).filter(Boolean) : ['기본단원'],
      bookmarked: Boolean(r.bookmarked)
    }));
    res.json(formatted);
  });
});

// 2. 신규 문제 등록
app.post('/api/questions', (req, res) => {
  const q = req.body;
  const sql = `
    INSERT INTO questions (id, number, grp, subject, category, type, text, choices, answer, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    q.id || `custom-${Date.now()}`,
    q.number || '1',
    q.group || '기타',
    q.subject || '헌법',
    q.category || '기본단원',
    q.type || 'ox',
    q.text || '',
    JSON.stringify(q.choices || []),
    q.answer || '',
    q.explanation || ''
  ];
  db.run(sql, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: params[0] });
  });
});

// 3. 문제 삭제
app.delete('/api/questions/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM questions WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.run(`DELETE FROM user_progress WHERE question_id = ?`, [id]);
    res.json({ success: true });
  });
});

// 4. 풀이 결과 기록 (정답/오답 통계 갱신)
app.post('/api/progress/attempt', (req, res) => {
  const { questionId, isCorrect } = req.body;
  const now = new Date().toISOString();
  const sql = `
    INSERT INTO user_progress (question_id, attempts, correct, wrong, last_attempt)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(question_id) DO UPDATE SET
      attempts = attempts + 1,
      correct = correct + ?,
      wrong = wrong + ?,
      last_attempt = ?
  `;
  const incC = isCorrect ? 1 : 0;
  const incW = isCorrect ? 0 : 1;
  db.run(sql, [questionId, incC, incW, now, incC, incW, now], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 5. 북마크 토글
app.post('/api/progress/bookmark', (req, res) => {
  const { questionId, bookmarked } = req.body;
  const val = bookmarked ? 1 : 0;
  const sql = `
    INSERT INTO user_progress (question_id, bookmarked)
    VALUES (?, ?)
    ON CONFLICT(question_id) DO UPDATE SET bookmarked = ?
  `;
  db.run(sql, [questionId, val, val], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 6. JSON 일괄 병합 업로드
app.post('/api/questions/import', (req, res) => {
  const { questions, mode } = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'questions 배열이 필요합니다.' });

  db.serialize(() => {
    if (mode === 'replace') {
      db.run(`DELETE FROM questions`);
      db.run(`DELETE FROM user_progress`);
    }
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO questions (id, number, grp, subject, category, type, text, choices, answer, explanation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    questions.forEach((q, i) => {
      stmt.run([
        String(q.id || `import-${Date.now()}-${i}`),
        String(q.number || i + 1),
        q.group || '',
        q.subject || '',
        Array.isArray(q.categoryPath) ? q.categoryPath.join(' > ') : (q.category || '기본단원'),
        q.type === 'ox' ? 'ox' : 'mcq',
        q.text || '',
        JSON.stringify(q.choices || []),
        q.answer || '',
        q.explanation || ''
      ]);
    });
    stmt.finalize((err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, count: questions.length });
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`서버 실행 중: 포트 ${PORT}`);
});