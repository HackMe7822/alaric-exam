const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { audit } = require('../utils/audit');

router.get('/queue', auth, requireRole('checker', 'exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { exam_id } = req.query;
  let sql = `
    SELECT ra.*, s.candidate_name, s.candidate_email, e.title as exam_title,
      q.body as question_body, q.type as question_type, q.marks,
      a.response, a.file_path, a.checker_verdict
    FROM review_assignments ra
    JOIN submissions s ON s.id=ra.submission_id
    JOIN questions q ON q.id=ra.question_id
    JOIN answers a ON a.submission_id=ra.submission_id AND a.question_id=ra.question_id
    JOIN exams e ON e.id=s.exam_id
    WHERE ra.status IN ('pending','in_review') AND (ra.assigned_to=? OR ra.assigned_to IS NULL)`;
  const params = [req.user.id];
  if (exam_id) { sql += ' AND s.exam_id=?'; params.push(parseInt(exam_id)); }
  sql += ' ORDER BY ra.assigned_at';
  res.json(db.prepare(sql).all(...params));
});

router.get('/queue/all', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT ra.*, s.candidate_name, e.title as exam_title,
      q.body as question_body, q.type, q.marks, a.response, a.checker_verdict, u.full_name as assigned_to_name
    FROM review_assignments ra
    JOIN submissions s ON s.id=ra.submission_id
    JOIN questions q ON q.id=ra.question_id
    JOIN answers a ON a.submission_id=ra.submission_id AND a.question_id=ra.question_id
    JOIN exams e ON e.id=s.exam_id
    LEFT JOIN users u ON u.id=ra.assigned_to
    ORDER BY ra.status, ra.assigned_at`).all());
});

router.post('/grade', auth, requireRole('checker', 'exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { assignment_id, verdict, remarks, manual_score } = req.body;
  if (!assignment_id || !verdict) return res.status(400).json({ error: 'assignment_id and verdict required' });
  if (!['correct', 'partial', 'incorrect'].includes(verdict)) return res.status(400).json({ error: 'Invalid verdict' });
  if (!remarks || remarks.trim().length < 3) return res.status(400).json({ error: 'Remarks are mandatory' });

  const ra = db.prepare('SELECT * FROM review_assignments WHERE id=?').get(parseInt(assignment_id));
  if (!ra) return res.status(404).json({ error: 'Assignment not found' });

  db.prepare(`
    UPDATE answers SET checker_verdict=?, checker_remarks=?, manual_score=?,
      checked_by=?, checked_at=datetime('now'), updated_at=datetime('now')
    WHERE submission_id=? AND question_id=?`)
    .run(verdict, remarks.trim(), manual_score != null ? parseFloat(manual_score) : null,
      req.user.id, ra.submission_id, ra.question_id);

  db.prepare(`UPDATE review_assignments SET status='done', completed_at=datetime('now') WHERE id=?`).run(ra.id);

  const pending = db.prepare(`SELECT COUNT(*) as c FROM review_assignments WHERE submission_id=? AND status NOT IN ('done','escalated')`).get(ra.submission_id);
  if (pending?.c === 0) {
    db.prepare(`UPDATE submissions SET status='graded', updated_at=datetime('now') WHERE id=?`).run(ra.submission_id);
  }

  audit(req.user.id, 'grade_answer', 'answer', ra.id, { verdict, manual_score }, req);
  res.json({ ok: true });
});

router.post('/assign', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { submission_id, question_id, assigned_to } = req.body;
  if (!question_id) {
    const answers = db.prepare(`
      SELECT a.question_id FROM answers a
      JOIN questions q ON q.id=a.question_id
      WHERE a.submission_id=? AND q.type IN ('text','file_upload') AND a.checker_verdict IS NULL`).all(parseInt(submission_id));
    const ins = db.prepare('INSERT OR IGNORE INTO review_assignments(submission_id, question_id, assigned_to) VALUES(?,?,?)');
    db.transaction(() => { for (const a of answers) ins.run(submission_id, a.question_id, assigned_to || null); })();
    return res.json({ assigned: answers.length });
  }
  db.prepare('INSERT OR IGNORE INTO review_assignments(submission_id, question_id, assigned_to) VALUES(?,?,?)')
    .run(parseInt(submission_id), parseInt(question_id), assigned_to || null);
  res.json({ ok: true });
});

router.post('/escalate', auth, requireRole('checker'), (req, res) => {
  const db = getDb();
  const { assignment_id, reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Reason required for escalation' });
  db.prepare(`UPDATE review_assignments SET status='escalated', escalation_reason=? WHERE id=?`).run(reason, parseInt(assignment_id));
  audit(req.user.id, 'escalate_review', 'review_assignment', parseInt(assignment_id), { reason }, req);
  res.json({ ok: true });
});

router.get('/stats', auth, requireRole('checker', 'exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status='escalated' THEN 1 ELSE 0 END) as escalated
    FROM review_assignments WHERE assigned_to=? OR assigned_to IS NULL`).get(req.user.id));
});

module.exports = router;
