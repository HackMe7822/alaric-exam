const express = require('express');
const router = express.Router();
const fs   = require('fs');
const path = require('path');
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { autoScoreSubmission } = require('../utils/scoring');
const { audit } = require('../utils/audit');

// GET /api/submissions?exam_id=&status=
router.get('/', auth, (req, res) => {
  const db = getDb();
  const { exam_id, status, candidate_id } = req.query;
  let sql = 'SELECT s.*, e.title as exam_title FROM submissions s JOIN exams e ON e.id=s.exam_id WHERE 1=1';
  const params = [];
  if (exam_id) { sql += ' AND s.exam_id=?'; params.push(parseInt(exam_id)); }
  if (status) { sql += ' AND s.status=?'; params.push(status); }
  if (candidate_id) { sql += ' AND s.candidate_id=?'; params.push(parseInt(candidate_id)); }
  sql += ' ORDER BY s.started_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/submissions/:id
router.get('/:id', auth, (req, res) => {
  const db = getDb();
  const sub = db.prepare('SELECT s.*, e.title as exam_title, e.pass_marks, e.total_marks FROM submissions s JOIN exams e ON e.id=s.exam_id WHERE s.id=?').get(parseInt(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });

  sub.answers = db.prepare(`SELECT a.*, q.type, q.body, q.marks, q.explanation,
    (SELECT json_group_array(json_object('id',o.id,'body',o.body,'is_correct',o.is_correct,'match_key',o.match_key))
     FROM question_options o WHERE o.question_id=a.question_id) as options_json
    FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.submission_id=? ORDER BY q.sort_order`).all(sub.id);

  sub.answers.forEach(a => {
    try { a.options = JSON.parse(a.options_json || '[]'); } catch { a.options = []; }
    delete a.options_json;
  });

  sub.snapshots = db.prepare('SELECT id, captured_at, event_type FROM snapshots WHERE submission_id=?').all(sub.id);
  try { sub.events = db.prepare('SELECT id, event_type, created_at FROM exam_events WHERE submission_id=? ORDER BY created_at ASC').all(sub.id); } catch(e) { sub.events = []; }
  try { sub.recordings = db.prepare('SELECT type, file_path, created_at FROM recordings WHERE submission_id=?').all(sub.id); } catch(e) { sub.recordings = []; }
  try { sub.chats = db.prepare('SELECT sender, sender_name, message, sent_at FROM exam_chats WHERE submission_id=? ORDER BY sent_at ASC').all(sub.id); } catch(e) { sub.chats = []; }
  res.json(sub);
});

// GET /api/submissions/:id/recording/:type — stream webcam or screen recording
router.get('/:id/recording/:type', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { type } = req.params;
  const id = parseInt(req.params.id);
  if (!['webcam','screen'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const rec = db.prepare('SELECT file_path FROM recordings WHERE submission_id=? AND type=?').get(id, type);
  if (!rec) return res.status(404).json({ error: 'No recording found' });
  const abs = path.join(__dirname, '..', '..', rec.file_path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File missing' });
  const stat = fs.statSync(abs);
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    res.status(206);
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(abs).pipe(res);
  }
});

// POST /api/submissions/:id/release-result
router.post('/:id/release-result', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const sub = db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
  if (!sub) return res.status(404).json({ error: 'Not found' });

  // Calculate final score
  const answers = db.prepare('SELECT * FROM answers WHERE submission_id=?').all(id);
  let manual = 0, hasManual = false;
  for (const a of answers) {
    if (a.manual_score != null) { manual += a.manual_score; hasManual = true; }
    else if (a.auto_score != null) { manual += a.auto_score; }
  }
  const finalScore = parseFloat(manual.toFixed(2));
  const exam = db.prepare('SELECT pass_marks FROM exams WHERE id=?').get(sub.exam_id);
  const passFail = exam?.pass_marks ? (finalScore >= exam.pass_marks ? 'pass' : 'fail') : null;

  db.prepare(`UPDATE submissions SET final_score=?, pass_fail=?, result_released=1, status='published', updated_at=datetime('now') WHERE id=?`).run(finalScore, passFail, id);

  audit(req.user.id, 'release_result', 'submission', id, { finalScore, passFail }, req);
  res.json({ ok: true, final_score: finalScore, pass_fail: passFail });
});

// POST /api/submissions/:id/bulk-score — trigger auto-score
router.post('/:id/auto-score', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const score = autoScoreSubmission(parseInt(req.params.id));
  res.json({ auto_score: score });
});

// POST /api/submissions/:id/flag — add integrity flag
router.post('/:id/flag', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { flag, notes } = req.body;
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT integrity_flags FROM submissions WHERE id=?').get(id);
  let flags = [];
  try { flags = JSON.parse(existing?.integrity_flags || '[]'); } catch {}
  flags.push({ flag, notes, added_by: req.user.id, at: new Date().toISOString() });
  db.prepare(`UPDATE submissions SET integrity_flags=?, review_notes=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(flags), notes||null, id);
  res.json({ ok: true });
});

// GET /api/submissions/:id/integrity-report
router.get('/:id/integrity-report', auth, (req, res) => {
  const db = getDb();
  const sub = db.prepare('SELECT * FROM submissions WHERE id=?').get(parseInt(req.params.id));
  if (!sub) return res.status(404).json({ error: 'Not found' });
  let flags = [];
  try { flags = JSON.parse(sub.integrity_flags || '[]'); } catch {}
  res.json({
    submission_id: sub.id,
    candidate: sub.candidate_name,
    risk_level: sub.risk_level,
    tab_switches: sub.tab_switches,
    fullscreen_exits: sub.fullscreen_exits,
    ai_paste_count: sub.ai_paste_count,
    snapshot_count: sub.snapshot_count,
    flags,
    review_notes: sub.review_notes
  });
});

module.exports = router;
