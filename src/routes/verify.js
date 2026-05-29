'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { getDb } = require('../../database/index');
const auth    = require('../middleware/auth');

// ─── Photo storage ────────────────────────────────────────────────────────────
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join('uploads', 'verifications', req.params.code || req.body.session_code || 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
    cb(null, `${file.fieldname}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')),
});

const PHOTO_FIELDS = [
  { name: 'photo_id_front',   label: 'ID Front' },
  { name: 'photo_id_back',    label: 'ID Back' },
  { name: 'photo_face',       label: 'Face Selfie' },
  { name: 'photo_desk_front', label: 'Desk Front' },
  { name: 'photo_desk_back',  label: 'Desk Back' },
  { name: 'photo_desk_left',  label: 'Desk Left' },
  { name: 'photo_desk_right', label: 'Desk Right' },
];

// ─── Unique code generator ────────────────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O 1/I confusion
  const p = n => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${p(3)}-${p(4)}-${p(3)}`;
}

// ─── POST /api/verify/create — called by Electron launcher to start a session ─
router.post('/create', (req, res) => {
  const db = getDb();
  const { linkToken } = req.body;
  if (!linkToken) return res.status(400).json({ error: 'linkToken required' });

  const link = db.prepare(
    'SELECT el.*, e.title as exam_title FROM exam_links el JOIN exams e ON e.id=el.exam_id WHERE el.token=?'
  ).get(linkToken);
  if (!link) return res.status(404).json({ error: 'Invalid exam link' });

  // Re-use existing pending/submitted session
  const existing = db.prepare(
    `SELECT session_code, status FROM exam_verifications WHERE link_token=? AND status NOT IN ('rejected') ORDER BY created_at DESC LIMIT 1`
  ).get(linkToken);
  if (existing) return res.json({ sessionCode: existing.session_code, status: existing.status });

  let code, attempts = 0;
  do {
    code = genCode();
    attempts++;
  } while (db.prepare('SELECT id FROM exam_verifications WHERE session_code=?').get(code) && attempts < 20);

  db.prepare(
    `INSERT INTO exam_verifications(session_code, link_token, candidate_name, candidate_email, exam_title)
     VALUES(?,?,?,?,?)`
  ).run(code, linkToken, link.candidate_name || '', link.candidate_email || '', link.exam_title || '');

  res.json({ sessionCode: code, status: 'pending' });
});

// ─── GET /api/verify/:code — get status (mobile page polls this) ──────────────
router.get('/:code', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM exam_verifications WHERE session_code=?').get(req.params.code);
  if (!row) return res.status(404).json({ error: 'Invalid code' });

  const photos = {};
  for (const { name } of PHOTO_FIELDS) photos[name] = !!row[name];

  res.json({
    status:        row.status,
    candidateName: row.candidate_name,
    examTitle:     row.exam_title,
    rejectReason:  row.reject_reason,
    photos,
  });
});

// ─── POST /api/verify/:code/photos — upload photos (from mobile or PC) ────────
router.post('/:code/photos', photoUpload.fields(PHOTO_FIELDS.map(f => ({ name: f.name, maxCount: 1 }))), (req, res) => {
  const db  = getDb();
  const row = db.prepare(
    `SELECT * FROM exam_verifications WHERE session_code=? AND status IN ('pending','photos_submitted')`
  ).get(req.params.code);
  if (!row) return res.status(404).json({ error: 'Invalid or expired code' });

  if (!req.files || !Object.keys(req.files).length) return res.status(400).json({ error: 'No photos received' });

  // Build SET clauses for only uploaded fields
  const updates = [];
  const vals    = [];
  for (const { name } of PHOTO_FIELDS) {
    if (req.files[name]?.[0]) {
      updates.push(`${name}=?`);
      vals.push(req.files[name][0].path);
    }
  }

  // Determine new status: photos_submitted only when all required photos present
  const merged = { ...row };
  for (const { name } of PHOTO_FIELDS) {
    if (req.files[name]?.[0]) merged[name] = req.files[name][0].path;
  }
  const required = ['photo_id_front', 'photo_face', 'photo_desk_front', 'photo_desk_back', 'photo_desk_left', 'photo_desk_right'];
  const allDone  = required.every(k => !!merged[k]);

  db.prepare(
    `UPDATE exam_verifications SET ${updates.join(',')}, status=?, updated_at=datetime('now') WHERE session_code=?`
  ).run(...vals, allDone ? 'photos_submitted' : 'pending', req.params.code);

  res.json({ ok: true, allDone, status: allDone ? 'photos_submitted' : 'pending' });
});

// ─── GET /api/verify/photo/:code/:field — serve a photo (admin auth) ──────────
router.get('/photo/:code/:field', auth, (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM exam_verifications WHERE session_code=?').get(req.params.code);
  if (!row) return res.status(404).end();

  const allowed = PHOTO_FIELDS.map(f => f.name);
  const field   = req.params.field;
  if (!allowed.includes(field) || !row[field]) return res.status(404).end();

  const full = path.resolve(row[field]);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(full);
});

// ─── Admin routes ─────────────────────────────────────────────────────────────
router.get('/admin/pending', auth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT session_code, candidate_name, candidate_email, exam_title, status, created_at,
            photo_id_front IS NOT NULL AS has_id_front,
            photo_id_back  IS NOT NULL AS has_id_back,
            photo_face     IS NOT NULL AS has_face,
            photo_desk_front IS NOT NULL AS has_desk_front,
            photo_desk_back  IS NOT NULL AS has_desk_back,
            photo_desk_left  IS NOT NULL AS has_desk_left,
            photo_desk_right IS NOT NULL AS has_desk_right
     FROM exam_verifications WHERE status IN ('pending','photos_submitted') ORDER BY created_at DESC`
  ).all();
  res.json(rows);
});

router.post('/admin/:code/approve', auth, (req, res) => {
  const db = getDb();
  db.prepare(
    `UPDATE exam_verifications SET status='approved', approved_by=?, updated_at=datetime('now') WHERE session_code=?`
  ).run(req.user?.id || null, req.params.code);
  res.json({ ok: true });
});

router.post('/admin/:code/reject', auth, (req, res) => {
  const db = getDb();
  const { reason } = req.body;
  db.prepare(
    `UPDATE exam_verifications SET status='rejected', reject_reason=?, updated_at=datetime('now') WHERE session_code=?`
  ).run(reason || 'Verification rejected by proctor', req.params.code);
  res.json({ ok: true });
});

module.exports = router;
