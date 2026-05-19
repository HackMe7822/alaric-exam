const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { audit } = require('../utils/audit');

// GET /api/question-bank
router.get('/', auth, (req, res) => {
  const db = getDb();
  const { category, difficulty, type, search } = req.query;
  let sql = 'SELECT * FROM question_bank WHERE 1=1';
  const params = [];
  if (category) { sql += ' AND category=?'; params.push(category); }
  if (difficulty) { sql += ' AND difficulty=?'; params.push(difficulty); }
  if (type) { sql += ' AND type=?'; params.push(type); }
  if (search) { sql += ' AND body LIKE ?'; params.push(`%${search}%`); }
  sql += ' ORDER BY created_at DESC';
  const questions = db.prepare(sql).all(...params);
  for (const q of questions) {
    q.options = db.prepare('SELECT * FROM bank_options WHERE bank_id=? ORDER BY sort_order').all(q.id);
  }
  res.json(questions);
});

// GET /api/question-bank/stats
router.get('/stats', auth, (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM question_bank').get()?.c || 0;
  const byType = db.prepare(`SELECT type, COUNT(*) as c FROM question_bank GROUP BY type`).all();
  const obj = {};
  for (const r of byType) obj[r.type] = r.c;
  res.json({ total, by_type: obj });
});

// GET /api/question-bank/categories
router.get('/categories', auth, (req, res) => {
  const db = getDb();
  const cats = db.prepare('SELECT DISTINCT category FROM question_bank WHERE category IS NOT NULL ORDER BY category').all();
  res.json(cats.map(c => c.category));
});

// POST /api/question-bank
router.post('/', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { category, subcategory, type, body, body_html, explanation, marks, difficulty, tags, options } = req.body;
  if (!type || !body) return res.status(400).json({ error: 'type and body required' });
  const r = db.prepare('INSERT INTO question_bank(category, subcategory, type, body, body_html, explanation, marks, difficulty, tags, created_by) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(category||null, subcategory||null, type, body, body_html||null, explanation||null, marks||1, difficulty||'medium', tags||null, req.user.id);
  const bid = r.lastInsertRowid;
  if (Array.isArray(options)) {
    const ins = db.prepare('INSERT INTO bank_options(bank_id, body, is_correct, match_key, sort_order) VALUES(?,?,?,?,?)');
    options.forEach((o, i) => ins.run(bid, o.body, o.is_correct?1:0, o.match_key||null, o.sort_order??i));
  }
  res.json({ id: bid });
});

// PUT /api/question-bank/:id
router.put('/:id', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { category, subcategory, type, body, body_html, explanation, marks, difficulty, tags, options } = req.body;
  db.prepare(`UPDATE question_bank SET category=?, subcategory=?, type=?, body=?, body_html=?, explanation=?, marks=?, difficulty=?, tags=?, updated_at=datetime('now') WHERE id=?`)
    .run(category||null, subcategory||null, type, body, body_html||null, explanation||null, marks||1, difficulty||'medium', tags||null, id);
  if (Array.isArray(options)) {
    db.prepare('DELETE FROM bank_options WHERE bank_id=?').run(id);
    const ins = db.prepare('INSERT INTO bank_options(bank_id, body, is_correct, match_key, sort_order) VALUES(?,?,?,?,?)');
    options.forEach((o, i) => ins.run(id, o.body, o.is_correct?1:0, o.match_key||null, o.sort_order??i));
  }
  res.json({ ok: true });
});

// DELETE /api/question-bank/:id
router.delete('/:id', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM question_bank WHERE id=?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// POST /api/question-bank/add-to-exam — copy bank questions to an exam
router.post('/add-to-exam', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { exam_id, bank_ids, section_id } = req.body;
  if (!exam_id || !Array.isArray(bank_ids)) return res.status(400).json({ error: 'exam_id and bank_ids required' });
  const created = [];
  db.transaction(() => {
    for (const bid of bank_ids) {
      const bq = db.prepare('SELECT * FROM question_bank WHERE id=?').get(bid);
      if (!bq) continue;
      const r = db.prepare(`INSERT INTO questions(exam_id, section_id, type, body, body_html, explanation, marks, difficulty, tags, bank_id, created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(parseInt(exam_id), section_id||null, bq.type, bq.body, bq.body_html, bq.explanation, bq.marks, bq.difficulty, bq.tags, bid, req.user.id);
      const qid = r.lastInsertRowid;
      const opts = db.prepare('SELECT * FROM bank_options WHERE bank_id=? ORDER BY sort_order').all(bid);
      for (const o of opts) {
        db.prepare('INSERT INTO question_options(question_id, body, is_correct, match_key, sort_order) VALUES(?,?,?,?,?)').run(qid, o.body, o.is_correct, o.match_key, o.sort_order);
      }
      db.prepare('UPDATE question_bank SET usage_count=usage_count+1 WHERE id=?').run(bid);
      created.push(qid);
    }
  })();
  // Recalc marks
  const totalMarks = db.prepare('SELECT COALESCE(SUM(marks),0) as t FROM questions WHERE exam_id=?').get(parseInt(exam_id));
  db.prepare('UPDATE exams SET total_marks=? WHERE id=?').run(totalMarks.t, parseInt(exam_id));

  audit(req.user.id, 'add_from_bank', 'exam', parseInt(exam_id), { count: created.length }, req);
  res.json({ added: created.length });
});

module.exports = router;
