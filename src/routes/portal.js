const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// Simple OTP store (in-memory for dev; use DB for production)
const otpStore = new Map(); // email -> {otp, expires}

// POST /api/portal/request-otp
router.post('/request-otp', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const db = getDb();
  const candidate = db.prepare('SELECT * FROM candidates WHERE email=? AND is_active=1').get(email.toLowerCase().trim());
  if (!candidate) return res.status(404).json({ error: 'No candidate found with this email' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry = parseInt(db.prepare(`SELECT value FROM settings WHERE key='candidate_otp_expiry'`).get()?.value || '10');
  otpStore.set(email.toLowerCase(), { otp, expires: Date.now() + expiry * 60 * 1000, candidate_id: candidate.id });

  // In production this would send via email; for now log to console
  console.log(`[Portal OTP] ${email}: ${otp} (expires in ${expiry} min)`);

  res.json({ ok: true, message: 'OTP sent to your email', debug_otp: process.env.NODE_ENV === 'development' ? otp : undefined });
});

// POST /api/portal/verify-otp
router.post('/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

  const entry = otpStore.get(email.toLowerCase());
  if (!entry || entry.otp !== otp || Date.now() > entry.expires) {
    return res.status(401).json({ error: 'Invalid or expired OTP' });
  }
  otpStore.delete(email.toLowerCase());

  const token = jwt.sign({ sub: entry.candidate_id, type: 'candidate' }, process.env.JWT_SECRET, { expiresIn: '4h' });
  res.json({ token });
});

function candidateAuth(req, res, next) {
  const token = req.cookies?.portal_token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== 'candidate') throw new Error('Wrong token type');
    req.candidateId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// GET /api/portal/profile
router.get('/profile', candidateAuth, (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, name, email, phone, employee_id FROM candidates WHERE id=?').get(req.candidateId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

// GET /api/portal/history
router.get('/history', candidateAuth, (req, res) => {
  const db = getDb();
  const submissions = db.prepare(`SELECT s.*, e.title as exam_title, e.total_marks, e.pass_marks
    FROM submissions s JOIN exams e ON e.id=s.exam_id
    WHERE s.candidate_id=? ORDER BY s.started_at DESC`).all(req.candidateId);
  res.json(submissions);
});

// GET /api/portal/result/:submissionId
router.get('/result/:id', candidateAuth, (req, res) => {
  const db = getDb();
  const sub = db.prepare('SELECT s.*, e.title, e.total_marks, e.pass_marks, e.show_result_immediately FROM submissions s JOIN exams e ON e.id=s.exam_id WHERE s.id=? AND s.candidate_id=?').get(parseInt(req.params.id), req.candidateId);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  if (!sub.result_released && !sub.show_result_immediately) return res.status(403).json({ error: 'Results not yet released' });

  const answers = db.prepare(`SELECT a.*, q.body, q.type, q.marks, q.explanation,
    (SELECT json_group_array(json_object('id',o.id,'body',o.body,'is_correct',o.is_correct)) FROM question_options o WHERE o.question_id=a.question_id) as options_json
    FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.submission_id=? ORDER BY q.sort_order`).all(sub.id);

  answers.forEach(a => { try { a.options = JSON.parse(a.options_json||'[]'); } catch { a.options=[]; } delete a.options_json; });
  res.json({ ...sub, answers });
});

// GET /api/portal/badges
router.get('/badges', candidateAuth, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM gamification WHERE candidate_id=? ORDER BY earned_at DESC').all(req.candidateId));
});

module.exports = router;
