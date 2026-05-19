const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { audit } = require('../utils/audit');

// GET /api/exams
router.get('/', auth, (req, res) => {
  const db = getDb();
  const { status, search } = req.query;
  let sql = 'SELECT e.*, u.full_name as creator_name FROM exams e LEFT JOIN users u ON u.id=e.created_by WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND e.status=?'; params.push(status); }
  if (search) { sql += ' AND (e.title LIKE ? OR e.code LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY e.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/exams/:id
router.get('/:id', auth, (req, res) => {
  const db = getDb();
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(parseInt(req.params.id));
  if (!exam) return res.status(404).json({ error: 'Not found' });
  const sections = db.prepare('SELECT * FROM sections WHERE exam_id=? ORDER BY sort_order').all(exam.id);
  const questions = db.prepare(`SELECT q.*, GROUP_CONCAT(o.id||'|'||o.body||'|'||o.is_correct||'|'||COALESCE(o.match_key,'')||'|'||o.sort_order, ';;') as options_raw
    FROM questions q LEFT JOIN question_options o ON o.question_id=q.id
    WHERE q.exam_id=? GROUP BY q.id ORDER BY q.sort_order`).all(exam.id);
  // Parse options
  questions.forEach(q => {
    if (q.options_raw) {
      q.options = q.options_raw.split(';;').map(r => {
        const [id, body, is_correct, match_key, sort_order] = r.split('|');
        return { id: parseInt(id), body, is_correct: parseInt(is_correct), match_key: match_key || null, sort_order: parseInt(sort_order) };
      });
    } else {
      q.options = [];
    }
    delete q.options_raw;
  });
  res.json({ ...exam, sections, questions });
});

// POST /api/exams
router.post('/', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { title, description, instructions, duration_minutes, total_marks, pass_marks, negative_marking,
    shuffle_questions, shuffle_options, show_result_immediately, allow_review, max_attempts,
    start_date, end_date, is_public, catalog_description, branding_color } = req.body;
  if (!title || !duration_minutes) return res.status(400).json({ error: 'Title and duration required' });

  const code = 'EX-' + Date.now().toString(36).toUpperCase();
  const r = db.prepare(`INSERT INTO exams(code, title, description, instructions, duration_minutes, total_marks, pass_marks,
    negative_marking, shuffle_questions, shuffle_options, show_result_immediately, allow_review, max_attempts,
    start_date, end_date, is_public, catalog_description, branding_color, created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, title, description||null, instructions||null, duration_minutes,
      total_marks||0, pass_marks||0, negative_marking||0,
      shuffle_questions?1:0, shuffle_options?1:0, show_result_immediately!==false?1:0,
      allow_review!==false?1:0, max_attempts||1, start_date||null, end_date||null,
      is_public?1:0, catalog_description||null, branding_color||'#002B5C', req.user.id);
  audit(req.user.id, 'create_exam', 'exam', r.lastInsertRowid, { title }, req);
  res.json({ id: r.lastInsertRowid, code });
});

// PUT /api/exams/:id
router.put('/:id', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const fields = ['title','description','instructions','duration_minutes','total_marks','pass_marks',
    'negative_marking','shuffle_questions','shuffle_options','show_result_immediately','allow_review',
    'max_attempts','start_date','end_date','is_public','catalog_description','branding_color',
    'branding_logo','certificate_template','status'];
  const updates = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f}=?`);
      vals.push(req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  updates.push(`updated_at=datetime('now')`);
  vals.push(id);
  db.prepare(`UPDATE exams SET ${updates.join(',')} WHERE id=?`).run(...vals);
  audit(req.user.id, 'update_exam', 'exam', id, req.body, req);
  res.json({ ok: true });
});

// DELETE /api/exams/:id
router.delete('/:id', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  db.prepare('DELETE FROM exams WHERE id=?').run(id);
  audit(req.user.id, 'delete_exam', 'exam', id, {}, req);
  res.json({ ok: true });
});

// GET /api/exams/:id/questions  — returns all questions with options for an exam
router.get('/:id/questions', auth, (req, res) => {
  const db = getDb();
  const examId = parseInt(req.params.id);
  const questions = db.prepare('SELECT * FROM questions WHERE exam_id=? ORDER BY sort_order, id').all(examId);
  for (const q of questions) {
    q.options = db.prepare('SELECT * FROM question_options WHERE question_id=? ORDER BY sort_order').all(q.id);
  }
  res.json(questions);
});

// DELETE /api/exams/:examId/questions/:qid
router.delete('/:id/questions/:qid', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const examId = parseInt(req.params.id);
  const qid = parseInt(req.params.qid);
  db.prepare('DELETE FROM questions WHERE id=? AND exam_id=?').run(qid, examId);
  const r = db.prepare('SELECT COALESCE(SUM(marks),0) as t FROM questions WHERE exam_id=?').get(examId);
  db.prepare('UPDATE exams SET total_marks=? WHERE id=?').run(r?.t || 0, examId);
  res.json({ ok: true });
});

// --- Sections ---
// GET /api/exams/:id/sections
router.get('/:id/sections', auth, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM sections WHERE exam_id=? ORDER BY sort_order').all(parseInt(req.params.id)));
});

// POST /api/exams/:id/sections
router.post('/:id/sections', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const exam_id = parseInt(req.params.id);
  const { title, description, duration_minutes, marks_per_question, sort_order } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const r = db.prepare('INSERT INTO sections(exam_id, title, description, duration_minutes, marks_per_question, sort_order) VALUES(?,?,?,?,?,?)')
    .run(exam_id, title, description||null, duration_minutes||null, marks_per_question||1, sort_order||0);
  res.json({ id: r.lastInsertRowid });
});

// PUT /api/exams/:id/sections/:sid
router.put('/:id/sections/:sid', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { title, description, duration_minutes, marks_per_question, sort_order } = req.body;
  db.prepare('UPDATE sections SET title=?, description=?, duration_minutes=?, marks_per_question=?, sort_order=? WHERE id=? AND exam_id=?')
    .run(title, description||null, duration_minutes||null, marks_per_question||1, sort_order||0,
      parseInt(req.params.sid), parseInt(req.params.id));
  res.json({ ok: true });
});

// DELETE /api/exams/:id/sections/:sid
router.delete('/:id/sections/:sid', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM sections WHERE id=? AND exam_id=?').run(parseInt(req.params.sid), parseInt(req.params.id));
  res.json({ ok: true });
});

// GET /api/exams/:id/export-csv
router.get('/:id/export-csv', auth, (req, res) => {
  const db = getDb();
  const examId = parseInt(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(examId);
  if (!exam) return res.status(404).json({ error: 'Not found' });

  const sections = db.prepare('SELECT * FROM sections WHERE exam_id=? ORDER BY sort_order').all(examId);
  const sectionMap = {};
  sections.forEach(s => { sectionMap[s.id] = s.title; });

  const questions = db.prepare('SELECT * FROM questions WHERE exam_id=? ORDER BY sort_order, id').all(examId);
  for (const q of questions) {
    q.options = db.prepare('SELECT * FROM question_options WHERE question_id=? ORDER BY sort_order').all(q.id);
  }

  const csvEscape = v => {
    const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const headers = ['#','Section','Type','Question','Option A','Option B','Option C','Option D',
    'Correct Answer','Explanation','Marks','Negative Marks','Difficulty','Tags'];
  const rows = [headers.join(',')];

  questions.forEach((q, i) => {
    const opts = q.options || [];
    const letters = ['A','B','C','D','E','F'];
    const correctLetters = opts
      .map((o, idx) => o.is_correct ? letters[idx] : null)
      .filter(Boolean).join('/');
    const row = [
      i + 1,
      sectionMap[q.section_id] || '',
      { mcq:'MCQ','multi-mcq':'Multi-MCQ',text:'Text','drag & drop':'Drag & Drop',match:'Match','fill blank':'Fill Blank',hotspot:'Hotspot','file upload':'File Upload' }[q.type?.toLowerCase()] || q.type || 'MCQ',
      q.body || '',
      opts[0]?.body || '',
      opts[1]?.body || '',
      opts[2]?.body || '',
      opts[3]?.body || '',
      correctLetters,
      q.explanation || '',
      q.marks ?? 1,
      q.negative_marks ?? 0,
      q.difficulty || 'medium',
      q.tags || '',
    ].map(csvEscape);
    rows.push(row.join(','));
  });

  const filename = `${(exam.title || 'exam').replace(/[^a-z0-9]/gi, '_')}_questions.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + rows.join('\r\n'));
});

// POST /api/exams/:id/publish
router.post('/:id/publish', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  db.prepare(`UPDATE exams SET status='published', updated_at=datetime('now') WHERE id=?`).run(id);
  audit(req.user.id, 'publish_exam', 'exam', id, {}, req);
  res.json({ ok: true });
});

// POST /api/exams/:id/archive
router.post('/:id/archive', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  db.prepare(`UPDATE exams SET status='archived', updated_at=datetime('now') WHERE id=?`).run(id);
  audit(req.user.id, 'archive_exam', 'exam', id, {}, req);
  res.json({ ok: true });
});

// POST /api/exams/:id/duplicate
router.post('/:id/duplicate', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const orig = db.prepare('SELECT * FROM exams WHERE id=?').get(parseInt(req.params.id));
  if (!orig) return res.status(404).json({ error: 'Not found' });

  const code = 'EX-' + Date.now().toString(36).toUpperCase();
  const { id: _, ...rest } = orig;
  const r = db.prepare(`INSERT INTO exams(code, title, description, instructions, duration_minutes, total_marks, pass_marks,
    negative_marking, shuffle_questions, shuffle_options, show_result_immediately, allow_review, max_attempts,
    start_date, end_date, is_public, catalog_description, branding_color, status, created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, `${orig.title} (Copy)`, orig.description, orig.instructions, orig.duration_minutes,
      orig.total_marks, orig.pass_marks, orig.negative_marking, orig.shuffle_questions, orig.shuffle_options,
      orig.show_result_immediately, orig.allow_review, orig.max_attempts, orig.start_date, orig.end_date,
      orig.is_public, orig.catalog_description, orig.branding_color, 'draft', req.user.id);

  const newId = r.lastInsertRowid;

  // Duplicate sections
  const sections = db.prepare('SELECT * FROM sections WHERE exam_id=?').all(orig.id);
  const sectionMap = {};
  for (const s of sections) {
    const sr = db.prepare('INSERT INTO sections(exam_id, title, description, duration_minutes, marks_per_question, sort_order) VALUES(?,?,?,?,?,?)')
      .run(newId, s.title, s.description, s.duration_minutes, s.marks_per_question, s.sort_order);
    sectionMap[s.id] = sr.lastInsertRowid;
  }

  // Duplicate questions and options
  const questions = db.prepare('SELECT * FROM questions WHERE exam_id=?').all(orig.id);
  for (const q of questions) {
    const qr = db.prepare(`INSERT INTO questions(exam_id, section_id, type, body, body_html, explanation, marks, negative_marks, time_limit_seconds, difficulty, tags, sort_order, is_required, created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newId, q.section_id ? sectionMap[q.section_id] : null, q.type, q.body, q.body_html, q.explanation,
        q.marks, q.negative_marks, q.time_limit_seconds, q.difficulty, q.tags, q.sort_order, q.is_required, req.user.id);
    const qNewId = qr.lastInsertRowid;
    const opts = db.prepare('SELECT * FROM question_options WHERE question_id=?').all(q.id);
    for (const o of opts) {
      db.prepare('INSERT INTO question_options(question_id, body, body_html, is_correct, match_key, sort_order, image_url) VALUES(?,?,?,?,?,?,?)')
        .run(qNewId, o.body, o.body_html, o.is_correct, o.match_key, o.sort_order, o.image_url);
    }
  }

  audit(req.user.id, 'duplicate_exam', 'exam', newId, { from: orig.id }, req);
  res.json({ id: newId, code });
});

module.exports = router;
