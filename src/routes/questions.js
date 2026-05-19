const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { audit } = require('../utils/audit');

const upload = multer({ dest: 'uploads/csv/', limits: { fileSize: 5 * 1024 * 1024 } });

// GET /api/questions?exam_id=&section_id=
router.get('/', auth, (req, res) => {
  const db = getDb();
  const { exam_id, section_id } = req.query;
  let sql = 'SELECT * FROM questions WHERE 1=1';
  const params = [];
  if (exam_id) { sql += ' AND exam_id=?'; params.push(parseInt(exam_id)); }
  if (section_id) { sql += ' AND section_id=?'; params.push(parseInt(section_id)); }
  sql += ' ORDER BY sort_order, id';
  const questions = db.prepare(sql).all(...params);
  // Attach options
  for (const q of questions) {
    q.options = db.prepare('SELECT * FROM question_options WHERE question_id=? ORDER BY sort_order').all(q.id);
  }
  res.json(questions);
});

// GET /api/questions/sample-csv — must be before /:id
router.get('/sample-csv', auth, (req, res) => {
  const csv = [
    'type,body,option_a,option_b,option_c,option_d,correct_option,marks,negative_marks,difficulty,explanation,tags',
    'mcq,What is 2+2?,2,3,4,5,C,1,0,easy,,math',
    'mcq,Capital of France?,London,Paris,Berlin,Madrid,B,1,0.25,medium,,geography',
    'text,Explain the water cycle.,,,,,,2,0,medium,Water evaporates then precipitates.,science',
    'fill_blank,The speed of light is approximately _____ km/s.,,,,,300000,1,0,hard,,physics',
    'multi_mcq,Select all prime numbers below.,2,3,4,5,A;B;D,2,0,easy,,math'
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sample_questions.csv"');
  res.send(csv);
});

// GET /api/questions/:id
router.get('/:id', auth, (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT * FROM questions WHERE id=?').get(parseInt(req.params.id));
  if (!q) return res.status(404).json({ error: 'Not found' });
  q.options = db.prepare('SELECT * FROM question_options WHERE question_id=? ORDER BY sort_order').all(q.id);
  q.versions = db.prepare('SELECT version, changed_at, changed_by FROM question_versions WHERE question_id=? ORDER BY version DESC').all(q.id);
  res.json(q);
});

// POST /api/questions
router.post('/', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { exam_id, section_id, type, body, body_html, explanation, marks, negative_marks,
    time_limit_seconds, difficulty, tags, sort_order, is_required, options } = req.body;
  if (!exam_id || !type || !body) return res.status(400).json({ error: 'exam_id, type, body required' });

  const r = db.prepare(`INSERT INTO questions(exam_id, section_id, type, body, body_html, explanation, marks,
    negative_marks, time_limit_seconds, difficulty, tags, sort_order, is_required, created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(parseInt(exam_id), section_id||null, type, body, body_html||null, explanation||null,
      marks||1, negative_marks||0, time_limit_seconds||null, difficulty||'medium',
      tags||null, sort_order||0, is_required!==false?1:0, req.user.id);

  const qid = r.lastInsertRowid;
  if (Array.isArray(options)) {
    saveOptions(db, qid, options);
  }

  // Save version
  saveVersion(db, qid, 1, req.body, req.user.id);

  // Recalculate exam total_marks
  recalcExamMarks(db, parseInt(exam_id));

  audit(req.user.id, 'create_question', 'question', qid, { exam_id, type }, req);
  res.json({ id: qid });
});

// PUT /api/questions/:id
router.put('/:id', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM questions WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { type, body, body_html, explanation, marks, negative_marks, time_limit_seconds,
    difficulty, tags, sort_order, section_id, options } = req.body;

  const newVersion = (existing.version || 1) + 1;
  db.prepare(`UPDATE questions SET type=?, body=?, body_html=?, explanation=?, marks=?, negative_marks=?,
    time_limit_seconds=?, difficulty=?, tags=?, sort_order=?, section_id=?, version=?, updated_at=datetime('now') WHERE id=?`)
    .run(type||existing.type, body||existing.body, body_html??existing.body_html,
      explanation??existing.explanation, marks??existing.marks, negative_marks??existing.negative_marks,
      time_limit_seconds??existing.time_limit_seconds, difficulty||existing.difficulty,
      tags??existing.tags, sort_order??existing.sort_order, section_id??existing.section_id, newVersion, id);

  if (Array.isArray(options)) {
    db.prepare('DELETE FROM question_options WHERE question_id=?').run(id);
    saveOptions(db, id, options);
  }

  saveVersion(db, id, newVersion, req.body, req.user.id);
  recalcExamMarks(db, existing.exam_id);
  audit(req.user.id, 'update_question', 'question', id, {}, req);
  res.json({ ok: true });
});

// DELETE /api/questions/:id
router.delete('/:id', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const q = db.prepare('SELECT exam_id FROM questions WHERE id=?').get(id);
  db.prepare('DELETE FROM questions WHERE id=?').run(id);
  if (q) recalcExamMarks(db, q.exam_id);
  audit(req.user.id, 'delete_question', 'question', id, {}, req);
  res.json({ ok: true });
});

// POST /api/questions/reorder — bulk sort_order update
router.post('/reorder', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { items } = req.body; // [{id, sort_order}]
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  const upd = db.prepare('UPDATE questions SET sort_order=? WHERE id=?');
  const tx = db.transaction(() => { for (const i of items) upd.run(i.sort_order, i.id); });
  tx();
  res.json({ ok: true });
});

// (duplicate removed — sample-csv route is defined before /:id above)

// POST /api/questions/import-csv?exam_id=
router.post('/import-csv', auth, requireRole('exam_manager', 'super_admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });
  const exam_id = parseInt(req.query.exam_id || req.body.exam_id);
  if (!exam_id) return res.status(400).json({ error: 'exam_id required' });

  let rows;
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: 'Invalid CSV: ' + e.message });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }

  const db = getDb();
  const validTypes = ['mcq','multi_mcq','text','drag_drop','match','fill_blank','hotspot','file_upload'];
  const errors = [];
  const created = [];

  db.transaction(() => {
    rows.forEach((row, i) => {
      const line = i + 2;
      const type = (row.type || '').toLowerCase().trim();
      if (!validTypes.includes(type)) { errors.push(`Row ${line}: invalid type "${type}"`); return; }
      if (!row.body) { errors.push(`Row ${line}: body required`); return; }

      const qr = db.prepare(`INSERT INTO questions(exam_id, type, body, marks, negative_marks, difficulty, explanation, tags, sort_order, created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(exam_id, type, row.body, parseFloat(row.marks)||1, parseFloat(row.negative_marks)||0,
          row.difficulty||'medium', row.explanation||null, row.tags||null, created.length, req.user.id);
      const qid = qr.lastInsertRowid;

      const opts = ['A','B','C','D','E'].map(l => row[`option_${l.toLowerCase()}`]).filter(Boolean);
      if (opts.length > 0) {
        const correctRaw = (row.correct_option || '').toUpperCase().split(';');
        const correctLetters = new Set(correctRaw);
        opts.forEach((body, idx) => {
          const letter = String.fromCharCode(65 + idx);
          db.prepare('INSERT INTO question_options(question_id, body, is_correct, sort_order) VALUES(?,?,?,?)')
            .run(qid, body, correctLetters.has(letter) ? 1 : 0, idx);
        });
      }
      created.push(qid);
    });
  })();

  recalcExamMarks(db, exam_id);
  audit(req.user.id, 'import_csv', 'exam', exam_id, { count: created.length }, req);
  res.json({ imported: created.length, errors });
});

function saveOptions(db, questionId, options) {
  const ins = db.prepare('INSERT INTO question_options(question_id, body, body_html, is_correct, match_key, sort_order, image_url) VALUES(?,?,?,?,?,?,?)');
  options.forEach((o, i) => ins.run(questionId, o.body||'', o.body_html||null, o.is_correct?1:0, o.match_key||null, o.sort_order??i, o.image_url||null));
}

function saveVersion(db, questionId, version, snapshot, userId) {
  db.prepare('INSERT INTO question_versions(question_id, version, snapshot, changed_by) VALUES(?,?,?,?)').run(questionId, version, JSON.stringify(snapshot), userId);
}

function recalcExamMarks(db, examId) {
  const r = db.prepare('SELECT COALESCE(SUM(marks),0) as total FROM questions WHERE exam_id=?').get(examId);
  db.prepare('UPDATE exams SET total_marks=? WHERE id=?').run(r?.total||0, examId);
}

module.exports = router;
