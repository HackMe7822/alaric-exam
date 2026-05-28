const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../../database/index');
const { autoScoreSubmission } = require('../utils/scoring');

const snapStorage = multer.diskStorage({
  destination: 'uploads/snapshots/',
  filename: (req, file, cb) => cb(null, `${Date.now()}-${req.params.token}.jpg`)
});
const snapUpload = multer({ storage: snapStorage, limits: { fileSize: 1024 * 1024 } });

const fileStorage = multer.diskStorage({
  destination: 'uploads/submissions/',
  filename: (req, file, cb) => cb(null, `${Date.now()}-${path.basename(file.originalname)}`)
});
const fileUpload = multer({ storage: fileStorage, limits: { fileSize: parseInt(process.env.MAX_FILE_MB || 10) * 1024 * 1024 } });

// GET /exam/:token
router.get('/:token', (req, res) => {
  const db = getDb();
  const link = db.prepare('SELECT * FROM exam_links WHERE token=? AND is_revoked=0').get(req.params.token);
  if (!link) return res.status(404).json({ error: 'Invalid or expired exam link' });
  const oneTime = link.one_time_link !== undefined ? link.one_time_link : 1;
  if (link.is_used && oneTime) {
    const latestSub = db.prepare('SELECT status FROM submissions WHERE link_id=? ORDER BY started_at DESC LIMIT 1').get(link.id);
    if (!latestSub || latestSub.status === 'cancelled') {
      db.prepare(`UPDATE exam_links SET is_used=0, used_at=NULL WHERE id=?`).run(link.id);
    } else {
      // Check if exam allows more attempts and candidate still has some remaining
      const exam = db.prepare('SELECT max_attempts, title FROM exams WHERE id=?').get(link.exam_id);
      const attemptsUsed = link.candidate_id
        ? db.prepare('SELECT COUNT(*) as c FROM submissions WHERE exam_id=? AND candidate_id=? AND COALESCE(is_abandoned,0)=0').get(link.exam_id, link.candidate_id).c
        : db.prepare('SELECT COUNT(*) as c FROM submissions WHERE link_id=? AND COALESCE(is_abandoned,0)=0').get(link.id).c;
      if (exam && exam.max_attempts > 1 && attemptsUsed < exam.max_attempts) {
        // More attempts still allowed — reset the link
        db.prepare(`UPDATE exam_links SET is_used=0, used_at=NULL WHERE id=?`).run(link.id);
      } else {
        return res.status(410).json({
          error: 'This link has already been used',
          exam_id: link.exam_id,
          exam_title: exam?.title || '',
          candidate_email: link.candidate_email || ''
        });
      }
    }
  }
  if (link.expires_at && new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'This link has expired' });

  const exam = db.prepare(`SELECT * FROM exams WHERE id=? AND status='published'`).get(link.exam_id);
  if (!exam) return res.status(404).json({ error: 'Exam not found or not published' });

  const sections = db.prepare('SELECT * FROM sections WHERE exam_id=? ORDER BY sort_order').all(exam.id);
  let questions = db.prepare('SELECT q.*, s.title as section_title FROM questions q LEFT JOIN sections s ON s.id=q.section_id WHERE q.exam_id=? ORDER BY q.sort_order').all(exam.id);

  if (exam.shuffle_questions) questions = shuffleArray(questions);
  questions = questions.map(q => {
    let opts = db.prepare('SELECT id, body, body_html, match_key, sort_order, image_url FROM question_options WHERE question_id=? ORDER BY sort_order').all(q.id);
    if (exam.shuffle_options && q.type === 'mcq') opts = shuffleArray(opts);
    return { ...q, options: opts };
  });

  const settings = {};
  const rows = db.prepare('SELECT key, value FROM settings WHERE key IN (?,?,?,?,?)').all('webcam_enabled', 'webcam_interval', 'fullscreen_enforce', 'ai_paste_detect', 'max_tab_switches');
  for (const r of rows) settings[r.key] = r.value;

  res.json({
    link: { id: link.id, candidate_name: link.candidate_name, candidate_email: link.candidate_email, exam_id: link.exam_id },
    exam: {
      id: exam.id, title: exam.title, description: exam.description, instructions: exam.instructions,
      duration_minutes: exam.duration_minutes, total_marks: exam.total_marks, pass_marks: exam.pass_marks,
      allow_review: exam.allow_review, branding_color: exam.branding_color, branding_logo: exam.branding_logo,
      require_screen_consent: exam.require_screen_consent || 0
    },
    sections, questions, settings
  });
});

// POST /exam/:token/start
router.post('/:token/start', (req, res) => {
  const db = getDb();
  const link = db.prepare('SELECT * FROM exam_links WHERE token=? AND is_revoked=0').get(req.params.token);
  if (!link) return res.status(410).json({ error: 'Link is invalid or revoked' });
  if (link.expires_at && new Date(link.expires_at) < new Date()) return res.status(410).json({ error: 'Link has expired' });
  const oneTime = link.one_time_link !== undefined ? link.one_time_link : 1;
  if (link.is_used && oneTime) {
    const latestSub = db.prepare('SELECT status FROM submissions WHERE link_id=? ORDER BY started_at DESC LIMIT 1').get(link.id);
    if (!latestSub || latestSub.status === 'cancelled') {
      db.prepare(`UPDATE exam_links SET is_used=0, used_at=NULL WHERE id=?`).run(link.id);
    } else {
      const exam = db.prepare('SELECT max_attempts FROM exams WHERE id=?').get(link.exam_id);
      const attemptsUsed = link.candidate_id
        ? db.prepare('SELECT COUNT(*) as c FROM submissions WHERE exam_id=? AND candidate_id=? AND COALESCE(is_abandoned,0)=0').get(link.exam_id, link.candidate_id).c
        : db.prepare('SELECT COUNT(*) as c FROM submissions WHERE link_id=? AND COALESCE(is_abandoned,0)=0').get(link.id).c;
      if (exam && exam.max_attempts > 1 && attemptsUsed < exam.max_attempts) {
        db.prepare(`UPDATE exam_links SET is_used=0, used_at=NULL WHERE id=?`).run(link.id);
      } else {
        return res.status(410).json({ error: 'Link is invalid, used, or revoked' });
      }
    }
  }

  db.prepare(`UPDATE exam_links SET is_used=1, used_at=datetime('now'), ip_used=? WHERE id=?`).run(req.ip, link.id);

  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(link.exam_id);
  if (link.candidate_id) {
    // Abandoned sessions (closed tab, no real submission) don't count toward attempt limit
    const attempts = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE exam_id=? AND candidate_id=? AND COALESCE(is_abandoned,0)=0').get(link.exam_id, link.candidate_id);
    if (exam.max_attempts > 0 && attempts.c >= exam.max_attempts) return res.status(409).json({ error: 'Maximum attempts reached' });
  }

  const r = db.prepare(`INSERT INTO submissions(link_id, exam_id, candidate_id, candidate_name, candidate_email, ip_address, browser) VALUES(?,?,?,?,?,?,?)`)
    .run(link.id, link.exam_id, link.candidate_id || null, link.candidate_name, link.candidate_email, req.ip, req.headers['user-agent'] || '');

  res.json({ submission_id: r.lastInsertRowid });
});

// POST /exam/:token/save-answer
router.post('/:token/save-answer', (req, res) => {
  const db = getDb();
  const { submission_id, question_id, response, time_spent_seconds, is_flagged } = req.body;
  if (!submission_id || !question_id) return res.status(400).json({ error: 'submission_id and question_id required' });

  const sub = db.prepare('SELECT s.* FROM submissions s JOIN exam_links el ON el.id=s.link_id WHERE s.id=? AND el.token=?').get(parseInt(submission_id), req.params.token);
  if (!sub) return res.status(403).json({ error: 'Forbidden' });
  if (sub.status !== 'in_progress') return res.status(409).json({ error: 'Submission already submitted' });

  const existing = db.prepare('SELECT id FROM answers WHERE submission_id=? AND question_id=?').get(parseInt(submission_id), parseInt(question_id));
  if (existing) {
    db.prepare(`UPDATE answers SET response=?, time_spent_seconds=?, is_flagged=?, updated_at=datetime('now') WHERE id=?`).run(response ?? null, time_spent_seconds || 0, is_flagged ? 1 : 0, existing.id);
  } else {
    db.prepare('INSERT INTO answers(submission_id, question_id, response, time_spent_seconds, is_flagged) VALUES(?,?,?,?,?)').run(parseInt(submission_id), parseInt(question_id), response ?? null, time_spent_seconds || 0, is_flagged ? 1 : 0);
  }
  res.json({ ok: true });
});

// POST /exam/:token/submit
router.post('/:token/submit', (req, res) => {
  const db = getDb();
  const { submission_id, time_taken_seconds } = req.body;
  const sub = db.prepare('SELECT s.* FROM submissions s JOIN exam_links el ON el.id=s.link_id WHERE s.id=? AND el.token=?').get(parseInt(submission_id), req.params.token);
  if (!sub) return res.status(403).json({ error: 'Forbidden' });
  if (sub.status !== 'in_progress') return res.json({ ok: true, already_submitted: true });

  db.prepare(`UPDATE submissions SET status='submitted', submitted_at=datetime('now'), time_taken_seconds=?, updated_at=datetime('now') WHERE id=?`).run(time_taken_seconds || 0, sub.id);

  const autoScore = autoScoreSubmission(sub.id);

  const textAnswers = db.prepare(`SELECT a.question_id FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.submission_id=? AND q.type IN ('text','file_upload')`).all(sub.id);
  if (textAnswers.length > 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO review_assignments(submission_id, question_id) VALUES(?,?)');
    db.transaction(() => { for (const a of textAnswers) ins.run(sub.id, a.question_id); })();
    db.prepare(`UPDATE submissions SET status='grading' WHERE id=?`).run(sub.id);
  }

  const exam = db.prepare('SELECT show_result_immediately, pass_marks, total_marks FROM exams WHERE id=?').get(sub.exam_id);
  res.json({ ok: true, auto_score: autoScore, show_result: exam?.show_result_immediately === 1, pass_marks: exam?.pass_marks, total_marks: exam?.total_marks });
});

// POST /exam/:token/event
router.post('/:token/event', (req, res) => {
  const db = getDb();
  const { submission_id, event_type } = req.body;
  const sub = db.prepare('SELECT s.* FROM submissions s JOIN exam_links el ON el.id=s.link_id WHERE s.id=? AND el.token=?').get(parseInt(submission_id), req.params.token);
  if (!sub) return res.status(403).json({ error: 'Forbidden' });

  const updates = [];
  const vals = [];
  if (event_type === 'tab_switch') { updates.push('tab_switches=tab_switches+1'); }
  if (event_type === 'fullscreen_exit') { updates.push('fullscreen_exits=fullscreen_exits+1'); }
  if (event_type === 'ai_paste') { updates.push('ai_paste_count=ai_paste_count+1'); }

  // Log individual event with timestamp
  try { db.prepare("INSERT INTO exam_events(submission_id, event_type) VALUES(?,?)").run(sub.id, event_type); } catch(e) {}

  const newTabSw = sub.tab_switches + (event_type === 'tab_switch' ? 1 : 0);
  const newFse = sub.fullscreen_exits + (event_type === 'fullscreen_exit' ? 1 : 0);
  const newAiP = sub.ai_paste_count + (event_type === 'ai_paste' ? 1 : 0);
  const risk = (newTabSw > 5 || newFse > 3 || newAiP > 2) ? 'high' : (newTabSw > 2 || newFse > 1 || newAiP > 0) ? 'medium' : 'low';
  updates.push('risk_level=?'); vals.push(risk);

  if (updates.length > 0) {
    vals.push(sub.id);
    db.prepare(`UPDATE submissions SET ${updates.join(',')} WHERE id=?`).run(...vals);
  }

  const maxSwitches = parseInt(db.prepare(`SELECT value FROM settings WHERE key='max_tab_switches'`).get()?.value || '3');
  if (event_type === 'tab_switch' && newTabSw >= maxSwitches) {
    db.prepare(`UPDATE submissions SET status='auto_submitted', submitted_at=datetime('now') WHERE id=? AND status='in_progress'`).run(sub.id);
    autoScoreSubmission(sub.id);
    return res.json({ ok: true, auto_submitted: true });
  }
  res.json({ ok: true });
});

// POST /exam/:token/snapshot
router.post('/:token/snapshot', snapUpload.single('image'), (req, res) => {
  const db = getDb();
  const { submission_id, event_type } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Image required' });
  const sub = db.prepare('SELECT s.* FROM submissions s JOIN exam_links el ON el.id=s.link_id WHERE s.id=? AND el.token=?').get(parseInt(submission_id), req.params.token);
  if (!sub) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Forbidden' }); }
  db.prepare('INSERT INTO snapshots(submission_id, file_path, event_type) VALUES(?,?,?)').run(sub.id, req.file.path, event_type || 'periodic');
  db.prepare('UPDATE submissions SET snapshot_count=snapshot_count+1 WHERE id=?').run(sub.id);
  res.json({ ok: true });
});

// POST /exam/:token/recording-chunk — append webcam/screen chunk to recording file
const recUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
router.post('/:token/recording-chunk', recUpload.single('chunk'), (req, res) => {
  const db = getDb();
  const { submission_id, type } = req.body;
  if (!req.file?.buffer?.length) return res.json({ ok: true });
  if (!['webcam', 'screen'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const sub = db.prepare('SELECT s.* FROM submissions s JOIN exam_links el ON el.id=s.link_id WHERE s.id=? AND el.token=?').get(parseInt(submission_id), req.params.token);
  if (!sub) return res.status(403).json({ error: 'Forbidden' });
  const dir = path.join(__dirname, '..', '..', 'uploads', 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sub.id}-${type}.webm`);
  fs.appendFileSync(filePath, req.file.buffer);
  const relPath = `uploads/recordings/${sub.id}-${type}.webm`;
  const existing = db.prepare('SELECT id FROM recordings WHERE submission_id=? AND type=?').get(sub.id, type);
  if (existing) {
    db.prepare(`UPDATE recordings SET updated_at=datetime('now') WHERE id=?`).run(existing.id);
  } else {
    db.prepare('INSERT INTO recordings(submission_id, type, file_path) VALUES(?,?,?)').run(sub.id, type, relPath);
  }
  res.json({ ok: true });
});

// POST /exam/:token/upload-file
router.post('/:token/upload-file', fileUpload.single('file'), (req, res) => {
  const db = getDb();
  const { submission_id, question_id } = req.body;
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const sub = db.prepare('SELECT s.* FROM submissions s JOIN exam_links el ON el.id=s.link_id WHERE s.id=? AND el.token=?').get(parseInt(submission_id), req.params.token);
  if (!sub) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: 'Forbidden' }); }
  const existing = db.prepare('SELECT id FROM answers WHERE submission_id=? AND question_id=?').get(parseInt(submission_id), parseInt(question_id));
  if (existing) {
    db.prepare(`UPDATE answers SET file_path=?, updated_at=datetime('now') WHERE id=?`).run(req.file.path, existing.id);
  } else {
    db.prepare('INSERT INTO answers(submission_id, question_id, file_path) VALUES(?,?,?)').run(parseInt(submission_id), parseInt(question_id), req.file.path);
  }
  res.json({ ok: true, file_path: req.file.path });
});

// POST /exam/:token/heartbeat — keeps in_progress submission alive
router.post('/:token/heartbeat', (req, res) => {
  const db = getDb();
  const { submission_id } = req.body || {};
  if (submission_id) {
    try { db.prepare(`UPDATE submissions SET updated_at=datetime('now') WHERE id=? AND status='in_progress'`).run(parseInt(submission_id)); } catch(e) {}
  }
  res.json({ ok: true });
});

// POST /exam/:token/abandon — candidate closed tab / manually cancelled
router.post('/:token/abandon', (req, res) => {
  const db = getDb();
  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }
  const { submission_id, reason } = body;
  if (!submission_id) return res.json({ ok: true });
  try {
    const sub = db.prepare('SELECT s.* FROM submissions s JOIN exam_links el ON el.id=s.link_id WHERE s.id=? AND el.token=?')
      .get(parseInt(submission_id), req.params.token);
    if (sub && sub.status === 'in_progress') {
      const cancelReason = (reason || 'abandoned').replace(/[^a-z_]/gi, '_').slice(0, 30);
      db.prepare(`UPDATE submissions SET
        status='auto_submitted', is_abandoned=1,
        submitted_at=datetime('now'), updated_at=datetime('now'),
        final_score=0, auto_score=0, pass_fail='fail',
        review_notes='Abandoned — candidate left exam without submitting'
        WHERE id=?`).run(sub.id);
      db.prepare("INSERT INTO exam_events(submission_id, event_type) VALUES(?,?)").run(sub.id, `abandoned_${cancelReason}`);
    }
  } catch(e) {}
  res.json({ ok: true });
});

// POST /exam/:token/request-new — candidate at dead-end requests a new link
router.post('/:token/request-new', (req, res) => {
  const db = getDb();
  const link = db.prepare('SELECT * FROM exam_links WHERE token=?').get(req.params.token);
  if (!link || !link.candidate_email) return res.status(404).json({ error: 'Invalid link' });
  const email = link.candidate_email.toLowerCase();
  const name = link.candidate_name || email;
  // Don't create duplicate pending requests
  const existing = db.prepare(`SELECT id FROM exam_access_requests WHERE exam_id=? AND email=? AND status='pending'`).get(link.exam_id, email);
  if (existing) return res.json({ ok: true, already_pending: true });
  db.prepare(`INSERT INTO exam_access_requests(exam_id, name, email, message) VALUES(?,?,?,?)`)
    .run(link.exam_id, name, email, 'Candidate requested a new exam link (previous link exhausted).');
  res.json({ ok: true });
});

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = router;
