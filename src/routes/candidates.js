const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { audit } = require('../utils/audit');
const { generateToken, buildExamUrl } = require('../utils/linkgen');
const { softDelete } = require('../utils/recycle');

// GET /api/candidates
router.get('/', auth, (req, res) => {
  const db = getDb();
  const { search, department_id } = req.query;
  let sql = 'SELECT c.*, d.name as dept_name FROM candidates c LEFT JOIN departments d ON d.id=c.department_id WHERE 1=1';
  const params = [];
  if (search) { sql += ' AND (c.name LIKE ? OR c.email LIKE ? OR c.employee_id LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (department_id) { sql += ' AND c.department_id=?'; params.push(parseInt(department_id)); }
  sql += ' ORDER BY c.name';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/candidates/:id
router.get('/:id', auth, (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT c.*, d.name as dept_name FROM candidates c LEFT JOIN departments d ON d.id=c.department_id WHERE c.id=?').get(parseInt(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.links = db.prepare('SELECT el.*, e.title as exam_title FROM exam_links el JOIN exams e ON e.id=el.exam_id WHERE el.candidate_id=? ORDER BY el.created_at DESC').all(c.id);
  c.submissions = db.prepare('SELECT s.*, e.title as exam_title FROM submissions s JOIN exams e ON e.id=s.exam_id WHERE s.candidate_id=? ORDER BY s.started_at DESC').all(c.id);
  res.json(c);
});

// POST /api/candidates
router.post('/', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { name, email, phone, employee_id, department_id, tags, notes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const r = db.prepare('INSERT INTO candidates(name, email, phone, employee_id, department_id, tags, notes) VALUES(?,?,?,?,?,?,?)')
      .run(name, email, phone||null, employee_id||null, department_id||null, tags||null, notes||null);
    audit(req.user.id, 'create_candidate', 'candidate', r.lastInsertRowid, { email }, req);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
    throw e;
  }
});

// PUT /api/candidates/:id
router.put('/:id', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { name, email, phone, employee_id, department_id, tags, notes, is_active } = req.body;
  const id = parseInt(req.params.id);
  db.prepare(`UPDATE candidates SET name=?, email=?, phone=?, employee_id=?, department_id=?, tags=?, notes=?, is_active=?, updated_at=datetime('now') WHERE id=?`)
    .run(name, email, phone||null, employee_id||null, department_id||null, tags||null, notes||null, is_active!==false?1:0, id);
  res.json({ ok: true });
});

// DELETE /api/candidates/:id — soft delete to recycle bin
router.delete('/:id', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const candidate = db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  softDelete(db, req.user.id, req.user.full_name || req.user.username, 'candidate', id, candidate);
  db.prepare('DELETE FROM candidates WHERE id=?').run(id);
  audit(req.user.id, 'delete_candidate', 'candidate', id, { name: candidate.name, email: candidate.email }, req);
  res.json({ ok: true });
});

// --- Exam Links ---
// GET /api/candidates/:id/links — list all exam links for a candidate
router.get('/:id/links', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const links = db.prepare(`
    SELECT el.*, e.title as exam_title
    FROM exam_links el
    JOIN exams e ON e.id = el.exam_id
    WHERE el.candidate_id = ?
    ORDER BY el.created_at DESC
  `).all(parseInt(req.params.id));
  res.json(links.map(l => ({ ...l, url: buildExamUrl(l.token) })));
});

// POST /api/candidates/:id/links — generate exam link for candidate
router.post('/:id/links', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const candidate_id = parseInt(req.params.id);
  const { exam_id, expires_hours } = req.body;
  if (!exam_id) return res.status(400).json({ error: 'exam_id required' });

  const candidate = db.prepare('SELECT * FROM candidates WHERE id=?').get(candidate_id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  const token = generateToken();
  const expires_at = expires_hours
    ? new Date(Date.now() + parseInt(expires_hours) * 3600000).toISOString()
    : null;

  db.prepare('INSERT INTO exam_links(token, exam_id, candidate_id, candidate_name, candidate_email, expires_at, created_by) VALUES(?,?,?,?,?,?,?)')
    .run(token, parseInt(exam_id), candidate_id, candidate.name, candidate.email, expires_at, req.user.id);

  audit(req.user.id, 'generate_link', 'exam_link', null, { candidate_id, exam_id }, req);
  res.json({ token, url: buildExamUrl(token), expires_at });
});

// POST /api/candidates/bulk-links — generate links for multiple candidates
router.post('/bulk-links', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { exam_id, candidate_ids, expires_hours } = req.body;
  if (!exam_id || !Array.isArray(candidate_ids)) return res.status(400).json({ error: 'exam_id and candidate_ids required' });

  const results = [];
  const ins = db.prepare('INSERT INTO exam_links(token, exam_id, candidate_id, candidate_name, candidate_email, expires_at, created_by) VALUES(?,?,?,?,?,?,?)');
  const expires_at = expires_hours ? new Date(Date.now() + parseInt(expires_hours) * 3600000).toISOString() : null;

  db.transaction(() => {
    for (const cid of candidate_ids) {
      const candidate = db.prepare('SELECT * FROM candidates WHERE id=?').get(cid);
      if (!candidate) continue;
      const token = generateToken();
      ins.run(token, parseInt(exam_id), cid, candidate.name, candidate.email, expires_at, req.user.id);
      results.push({ candidate_id: cid, name: candidate.name, email: candidate.email, token, url: buildExamUrl(token) });
    }
  })();

  audit(req.user.id, 'bulk_generate_links', 'exam', parseInt(exam_id), { count: results.length }, req);
  res.json(results);
});

// GET /api/candidates/links?exam_id=
router.get('/links/list', auth, (req, res) => {
  const db = getDb();
  const { exam_id } = req.query;
  let sql = `SELECT el.*, e.title as exam_title, c.name as candidate_name, c.email as candidate_email
    FROM exam_links el JOIN exams e ON e.id=el.exam_id LEFT JOIN candidates c ON c.id=el.candidate_id WHERE 1=1`;
  const params = [];
  if (exam_id) { sql += ' AND el.exam_id=?'; params.push(parseInt(exam_id)); }
  sql += ' ORDER BY el.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// POST /api/candidates/links/:token/revoke
router.post('/links/:token/revoke', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  db.prepare('UPDATE exam_links SET is_revoked=1 WHERE token=?').run(req.params.token);
  res.json({ ok: true });
});

// GET /api/departments
router.get('/departments/list', auth, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM departments ORDER BY name').all());
});

// GET /api/candidates/:id/history — all submissions + recordings + events for a candidate
router.get('/:id/history', auth, (req, res) => {
  const db = getDb();
  const candId = parseInt(req.params.id);
  const submissions = db.prepare(`
    SELECT s.id, s.status, s.started_at, s.submitted_at, s.auto_score, s.final_score,
           s.tab_switches, s.fullscreen_exits, s.time_taken_seconds, e.title as exam_title
    FROM submissions s JOIN exams e ON e.id=s.exam_id
    WHERE s.candidate_id=? ORDER BY s.started_at DESC
  `).all(candId);
  const result = submissions.map(s => {
    const recordings = db.prepare('SELECT type FROM recordings WHERE submission_id=?').all(s.id);
    const events = db.prepare('SELECT event_type, created_at FROM exam_events WHERE submission_id=? ORDER BY created_at DESC LIMIT 30').all(s.id);
    return { ...s, recordings, events };
  });
  res.json(result);
});

// GET /api/candidates/recordings/:submissionId/:type — stream recording file to admin
router.get('/recordings/:submissionId/:type', auth, (req, res) => {
  const db = getDb();
  const rec = db.prepare('SELECT file_path FROM recordings WHERE submission_id=? AND type=?')
    .get(parseInt(req.params.submissionId), req.params.type);
  if (!rec) return res.status(404).json({ error: 'Recording not found' });
  const fullPath = path.resolve(rec.file_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found on disk' });
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Disposition', `inline; filename="${req.params.submissionId}-${req.params.type}.webm"`);
  res.sendFile(fullPath);
});

// POST /api/departments
router.post('/departments', auth, requireRole('super_admin', 'exam_manager'), (req, res) => {
  const db = getDb();
  const { name, code, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO departments(name, code, description) VALUES(?,?,?)').run(name, code||null, description||null);
  res.json({ id: r.lastInsertRowid });
});

module.exports = router;
