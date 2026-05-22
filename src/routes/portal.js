const express = require('express');
const router = express.Router();
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { getDb } = require('../../database/index');
const { buildExamUrl } = require('../utils/linkgen');
const { sendEmail } = require('../utils/email');
const jwt = require('jsonwebtoken');

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

// POST /api/portal/login — email + password
router.post('/login', (req, res) => {
  const db = getDb();
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const cleanEmail = email.toLowerCase().trim();
  const candidate = db.prepare('SELECT * FROM candidates WHERE email=? AND is_active=1').get(cleanEmail);
  if (!candidate) return res.status(401).json({ error: 'No account found with this email.' });
  if (!candidate.password_hash) return res.status(401).json({ error: 'This account uses social login. Please use the Google or Microsoft button, or reset your password via email code.', no_password: true });
  if (!bcrypt.compareSync(password, candidate.password_hash)) return res.status(401).json({ error: 'Incorrect password.' });
  const token = jwt.sign({ sub: candidate.id, type: 'candidate' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('portal_token', token, { httpOnly: true, maxAge: 7 * 24 * 3600000, sameSite: 'lax' });
  res.json({ token, candidate: { id: candidate.id, name: candidate.name, email: candidate.email, phone: candidate.phone } });
});

// POST /api/portal/set-password — set/change password (authenticated)
router.post('/set-password', candidateAuth, (req, res) => {
  const db = getDb();
  const { new_password } = req.body;
  if (!new_password || new_password.trim().length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const hash = bcrypt.hashSync(new_password.trim(), 10);
  db.prepare(`UPDATE candidates SET password_hash=?, updated_at=datetime('now') WHERE id=?`).run(hash, req.candidateId);
  res.json({ ok: true });
});

// POST /api/portal/request-otp
router.post('/request-otp', async (req, res) => {
  const db = getDb();
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const cleanEmail = email.toLowerCase().trim();
  const candidate = db.prepare('SELECT * FROM candidates WHERE email=? AND is_active=1').get(cleanEmail);
  if (!candidate) return res.status(404).json({ error: 'No account found with this email. Please register first.' });

  // Rate limit: 1 OTP per 60s
  const recent = db.prepare(
    `SELECT id FROM email_otps WHERE email=? AND purpose='portal_login' AND datetime(created_at) > datetime('now','-60 seconds')`
  ).get(cleanEmail);
  if (recent) return res.status(429).json({ error: 'Please wait 60 seconds before requesting another code.' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires_at = new Date(Date.now() + 10 * 60000).toISOString();
  const payload = JSON.stringify({ candidate_id: candidate.id });

  db.prepare(`DELETE FROM email_otps WHERE email=? AND purpose='portal_login'`).run(cleanEmail);
  db.prepare(`INSERT INTO email_otps(email, otp_code, expires_at, purpose, payload) VALUES(?,?,?,?,?)`)
    .run(cleanEmail, otp, expires_at, 'portal_login', payload);

  const loginHtml = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px">
    <h2 style="color:#4f46e5;margin-bottom:4px">Sign in to Alaric Exam</h2>
    <p>Hi ${candidate.name},</p>
    <p>Your sign-in code is:</p>
    <div style="background:#f3f4f6;border-radius:12px;padding:28px;text-align:center;margin:24px 0">
      <span style="font-size:40px;font-weight:800;letter-spacing:10px;color:#111827;font-family:monospace">${otp}</span>
    </div>
    <p style="color:#6b7280;font-size:14px">This code expires in <strong>10 minutes</strong>.</p>
    <p style="color:#6b7280;font-size:14px">If you did not request this, please ignore this email.</p>
  </div>`;
  try {
    await sendEmail({ to: cleanEmail, subject: `${otp} — your Alaric Exam sign-in code`, html: loginHtml, templateCode: 'portal_otp', purpose: 'system' });
  } catch (e) {
    console.error('[portal] OTP email error:', e.message);
    db.prepare(`DELETE FROM email_otps WHERE email=? AND purpose='portal_login'`).run(cleanEmail);
    return res.status(503).json({ error: 'Failed to send login code. Please check your email settings or try again.' });
  }
  res.json({ ok: true });
});

// POST /api/portal/verify-otp
router.post('/verify-otp', (req, res) => {
  const db = getDb();
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

  const cleanEmail = email.toLowerCase().trim();
  const record = db.prepare(`SELECT * FROM email_otps WHERE email=? AND purpose='portal_login'`).get(cleanEmail);
  if (!record) return res.status(401).json({ error: 'Code expired or not found. Please request a new one.' });

  if (new Date(record.expires_at) < new Date()) {
    db.prepare(`DELETE FROM email_otps WHERE id=?`).run(record.id);
    return res.status(401).json({ error: 'Code has expired. Please request a new one.' });
  }
  if (record.attempts >= 3) {
    db.prepare(`DELETE FROM email_otps WHERE id=?`).run(record.id);
    return res.status(401).json({ error: 'Too many incorrect attempts. Please request a new code.' });
  }
  if (record.otp_code !== otp.trim()) {
    db.prepare(`UPDATE email_otps SET attempts=attempts+1 WHERE id=?`).run(record.id);
    const remaining = 2 - record.attempts;
    return res.status(401).json({ error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` });
  }

  db.prepare(`DELETE FROM email_otps WHERE id=?`).run(record.id);
  const { candidate_id } = JSON.parse(record.payload);
  const candidate = db.prepare('SELECT id, name, email, phone FROM candidates WHERE id=?').get(candidate_id);
  if (!candidate) return res.status(404).json({ error: 'Account not found.' });

  const token = jwt.sign({ sub: candidate.id, type: 'candidate' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('portal_token', token, { httpOnly: true, maxAge: 7 * 24 * 3600000, sameSite: 'lax' });
  res.json({ token, candidate });
});

// GET /api/portal/profile
router.get('/profile', candidateAuth, (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT id, name, email, phone, phone_verified, employee_id, organization, address, city, state, country, postal_code, photo, created_at FROM candidates WHERE id=?').get(req.candidateId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

// PUT /api/portal/profile
router.put('/profile', candidateAuth, (req, res) => {
  const db = getDb();
  const { name, phone, organization, address, city, state, country, postal_code } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  // If phone changed, clear phone_verified
  const existing = db.prepare('SELECT phone FROM candidates WHERE id=?').get(req.candidateId);
  const phoneChanged = phone?.trim() !== (existing?.phone || '');
  db.prepare(`UPDATE candidates SET name=?, phone=?, phone_verified=?, organization=?, address=?, city=?, state=?, country=?, postal_code=?, updated_at=datetime('now') WHERE id=?`)
    .run(name.trim(), phone?.trim()||null, phoneChanged ? 0 : (existing?.phone_verified || 0),
         organization?.trim()||null, address?.trim()||null, city?.trim()||null,
         state?.trim()||null, country?.trim()||null, postal_code?.trim()||null, req.candidateId);
  res.json({ ok: true });
});

// POST /api/portal/phone/send-otp — send OTP to email to verify a phone number
router.post('/phone/send-otp', candidateAuth, async (req, res) => {
  const db = getDb();
  const { phone } = req.body;
  if (!phone || phone.trim().length < 5) return res.status(400).json({ error: 'Valid phone number required' });
  const candidate = db.prepare('SELECT id, email, name FROM candidates WHERE id=?').get(req.candidateId);
  if (!candidate) return res.status(404).json({ error: 'Not found' });
  // Rate-limit: one OTP per 60s
  const recent = db.prepare(`SELECT id FROM email_otps WHERE email=? AND purpose='phone_verify' AND datetime(created_at) > datetime('now','-60 seconds')`).get(candidate.email);
  if (recent) return res.status(429).json({ error: 'Please wait 60 seconds before requesting another code.' });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires_at = new Date(Date.now() + 15 * 60000).toISOString();
  db.prepare(`DELETE FROM email_otps WHERE email=? AND purpose='phone_verify'`).run(candidate.email);
  db.prepare(`INSERT INTO email_otps(email, otp_code, expires_at, purpose, payload) VALUES(?,?,?,?,?)`)
    .run(candidate.email, otp, expires_at, 'phone_verify', JSON.stringify({ phone: phone.trim() }));
  const html = `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;border:1px solid #e2e8f0;border-radius:10px">
    <h2 style="color:#0078d4;margin:0 0 8px">Verify Your Phone Number</h2>
    <p style="color:#555;margin:0 0 24px">Hi ${candidate.name || 'there'}, use this code to verify <strong>${phone.trim()}</strong> as your phone number.</p>
    <div style="background:#f0f7ff;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px">
      <span style="font-size:36px;font-weight:800;letter-spacing:10px;color:#111827;font-family:monospace">${otp}</span>
    </div>
    <p style="color:#888;font-size:13px;margin:0">This code expires in 15 minutes. If you did not request this, please ignore this email.</p>
  </div>`;
  try {
    await sendEmail({ to: candidate.email, subject: `${otp} — verify your phone number`, html, templateCode: 'phone_verify', purpose: 'system' });
  } catch(e) {
    console.error('[portal] phone OTP email error:', e.message);
    db.prepare(`DELETE FROM email_otps WHERE email=? AND purpose='phone_verify'`).run(candidate.email);
    return res.status(503).json({ error: 'Failed to send verification email. Please check your email settings or try again.' });
  }
  res.json({ ok: true });
});

// POST /api/portal/phone/verify-otp — confirm code and mark phone verified
router.post('/phone/verify-otp', candidateAuth, (req, res) => {
  const db = getDb();
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: 'OTP required' });
  const candidate = db.prepare('SELECT email FROM candidates WHERE id=?').get(req.candidateId);
  if (!candidate) return res.status(404).json({ error: 'Not found' });
  const record = db.prepare(`SELECT * FROM email_otps WHERE email=? AND purpose='phone_verify'`).get(candidate.email);
  if (!record) return res.status(400).json({ error: 'No pending verification. Please request a new code.' });
  if (new Date(record.expires_at) < new Date()) {
    db.prepare(`DELETE FROM email_otps WHERE id=?`).run(record.id);
    return res.status(400).json({ error: 'Code expired. Please request a new one.' });
  }
  if ((record.attempts || 0) >= 5) {
    db.prepare(`DELETE FROM email_otps WHERE id=?`).run(record.id);
    return res.status(400).json({ error: 'Too many incorrect attempts. Please request a new code.' });
  }
  if (record.otp_code !== otp.trim()) {
    db.prepare(`UPDATE email_otps SET attempts=attempts+1 WHERE id=?`).run(record.id);
    return res.status(400).json({ error: 'Incorrect code. Please try again.' });
  }
  let payload = {};
  try { payload = JSON.parse(record.payload || '{}'); } catch(e) {}
  db.prepare(`DELETE FROM email_otps WHERE id=?`).run(record.id);
  if (payload.phone) {
    db.prepare(`UPDATE candidates SET phone=?, phone_verified=1, updated_at=datetime('now') WHERE id=?`)
      .run(payload.phone, req.candidateId);
  }
  res.json({ ok: true, phone: payload.phone });
});

// POST /api/portal/profile/photo — upload profile photo (base64, max ~1MB)
router.post('/profile/photo', candidateAuth, (req, res) => {
  const db = getDb();
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: 'No photo provided.' });
  if (photo.length > 1400000) return res.status(400).json({ error: 'Image too large. Please use an image under 1MB.' });
  db.prepare(`UPDATE candidates SET photo=?, updated_at=datetime('now') WHERE id=?`).run(photo, req.candidateId);
  res.json({ ok: true });
});

// GET /api/portal/requests — access requests for this candidate (by email)
router.get('/requests', candidateAuth, (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT email FROM candidates WHERE id=?').get(req.candidateId);
  if (!c) return res.json([]);
  const rows = db.prepare(`
    SELECT r.id, r.status, r.created_at, r.email_verified, r.phone, r.link_token,
      e.title as exam_title, e.code, e.duration_minutes, e.total_marks, e.pass_marks
    FROM exam_access_requests r
    JOIN exams e ON e.id=r.exam_id
    WHERE r.email=?
    ORDER BY r.created_at DESC
  `).all(c.email);
  res.json(rows.map(r => ({
    ...r,
    exam_url: r.link_token ? buildExamUrl(r.link_token) : null,
  })));
});

// GET /api/portal/my-exams — exam links for this candidate (active + in-progress)
router.get('/my-exams', candidateAuth, (req, res) => {
  const db = getDb();
  const c = db.prepare('SELECT email FROM candidates WHERE id=?').get(req.candidateId);
  if (!c) return res.json([]);
  const links = db.prepare(`
    SELECT el.token, el.expires_at, el.used_at, el.is_revoked, el.is_used,
      COALESCE(el.one_time_link, 1) as one_time_link,
      e.id as exam_id, e.title, e.code, e.duration_minutes, e.total_marks, e.pass_marks,
      e.catalog_image as thumbnail,
      (SELECT status FROM submissions WHERE link_id=el.id ORDER BY started_at DESC LIMIT 1) as sub_status,
      (SELECT id FROM submissions WHERE link_id=el.id ORDER BY started_at DESC LIMIT 1) as sub_id
    FROM exam_links el
    JOIN exams e ON e.id=el.exam_id
    WHERE el.candidate_email=? AND el.is_revoked=0
      AND (el.expires_at IS NULL OR datetime(el.expires_at) > datetime('now'))
    ORDER BY el.created_at DESC
  `).all(c.email);
  // Filter out links where the exam is fully done (submitted/graded — they live in history)
  const completedStatuses = new Set(['submitted', 'grading', 'graded', 'auto_submitted']);
  const active = links.filter(l => !completedStatuses.has(l.sub_status));
  res.json(active.map(l => ({ ...l, exam_url: buildExamUrl(l.token) })));
});

// GET /api/portal/history — all submissions for this candidate
router.get('/history', candidateAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.id, s.started_at, s.submitted_at, s.completed_at, s.score, s.passed,
      s.result_released, s.status,
      e.title as exam_title, e.code, e.total_marks, e.pass_marks, e.show_result_immediately
    FROM submissions s JOIN exams e ON e.id=s.exam_id
    WHERE s.candidate_id=? ORDER BY s.started_at DESC
  `).all(req.candidateId);
  res.json(rows);
});

// POST /api/portal/logout
router.post('/logout', (req, res) => {
  res.clearCookie('portal_token');
  res.json({ ok: true });
});

/* ─── OAUTH base URL helper ─── */
function getBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  // Auto-detect from request (works behind Render / any HTTPS proxy)
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}`;
}

/* ─── GOOGLE OAUTH ─── */
router.get('/auth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.redirect('/portal/oauth-callback?oauth_error=' + encodeURIComponent('Google login is not configured. Add GOOGLE_CLIENT_ID to environment variables.'));
  const base = getBaseUrl(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${base}/api/portal/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/auth/google/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error || !code) {
    const msg = error_description || error || 'Authentication cancelled.';
    return res.redirect('/portal/oauth-callback?oauth_error=' + encodeURIComponent(msg));
  }
  try {
    const base = getBaseUrl(req);
    const redirectUri = `${base}/api/portal/auth/google/callback`;
    console.log('[portal] Google callback — base:', base, 'redirect_uri:', redirectUri);
    const tokenResp = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const userResp = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenResp.data.access_token}` },
    });
    const { email, name } = userResp.data;
    if (!email) throw new Error('No email returned from Google');

    const db = getDb();
    const cleanEmail = email.toLowerCase().trim();
    let candidate = db.prepare('SELECT id FROM candidates WHERE email=?').get(cleanEmail);
    if (!candidate) {
      const r = db.prepare(`INSERT INTO candidates(name, email, is_active, created_at, updated_at) VALUES(?,?,1,datetime('now'),datetime('now'))`).run(name || cleanEmail, cleanEmail);
      candidate = { id: r.lastInsertRowid };
    }
    const token = jwt.sign({ sub: candidate.id, type: 'candidate' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.cookie('portal_token', token, { httpOnly: true, maxAge: 7 * 24 * 3600000, sameSite: 'lax' });
    res.redirect('/portal/oauth-callback?token=' + encodeURIComponent(token));
  } catch (e) {
    const detail = e.response?.data?.error_description || e.response?.data?.error || e.message;
    console.error('[portal] Google OAuth error:', detail);
    res.redirect('/portal/oauth-callback?oauth_error=' + encodeURIComponent('Google sign-in failed: ' + detail));
  }
});

/* ─── MICROSOFT OAUTH ─── */
router.get('/auth/microsoft', (req, res) => {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) return res.redirect('/portal/oauth-callback?oauth_error=' + encodeURIComponent('Microsoft login is not configured. Add MICROSOFT_CLIENT_ID to environment variables.'));
  const base = getBaseUrl(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${base}/api/portal/auth/microsoft/callback`,
    response_type: 'code',
    scope: 'openid email profile User.Read',
    response_mode: 'query',
    prompt: 'select_account',
  });
  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
});

router.get('/auth/microsoft/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error || !code) {
    const msg = error_description || error || 'Authentication cancelled.';
    return res.redirect('/portal/oauth-callback?oauth_error=' + encodeURIComponent(msg));
  }
  try {
    const base = getBaseUrl(req);
    const redirectUri = `${base}/api/portal/auth/microsoft/callback`;
    console.log('[portal] Microsoft callback — base:', base, 'redirect_uri:', redirectUri);
    const tokenResp = await axios.post(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: 'openid email profile User.Read',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const userResp = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokenResp.data.access_token}` },
    });
    const { mail, userPrincipalName, displayName } = userResp.data;
    const email = (mail || userPrincipalName || '').toLowerCase().trim();
    if (!email) throw new Error('No email returned from Microsoft');

    const db = getDb();
    let candidate = db.prepare('SELECT id FROM candidates WHERE email=?').get(email);
    if (!candidate) {
      const r = db.prepare(`INSERT INTO candidates(name, email, is_active, created_at, updated_at) VALUES(?,?,1,datetime('now'),datetime('now'))`).run(displayName || email, email);
      candidate = { id: r.lastInsertRowid };
    }
    const token = jwt.sign({ sub: candidate.id, type: 'candidate' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.cookie('portal_token', token, { httpOnly: true, maxAge: 7 * 24 * 3600000, sameSite: 'lax' });
    res.redirect('/portal/oauth-callback?token=' + encodeURIComponent(token));
  } catch (e) {
    const detail = e.response?.data?.error_description || e.response?.data?.error || e.message;
    console.error('[portal] Microsoft OAuth error:', detail);
    res.redirect('/portal/oauth-callback?oauth_error=' + encodeURIComponent('Microsoft sign-in failed: ' + detail));
  }
});

/* ─── DIRECT REGISTRATION (from portal login page, no exam) ─── */
router.post('/register', (req, res) => {
  const db = getDb();
  const { name, email, phone, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
  if (password.trim().length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const cleanEmail = email.toLowerCase().trim();
  const existing = db.prepare('SELECT id FROM candidates WHERE email=?').get(cleanEmail);
  if (existing) return res.status(409).json({ error: 'An account already exists with this email. Please sign in.' });
  const hash = bcrypt.hashSync(password.trim(), 10);
  const r = db.prepare(`INSERT INTO candidates(name, email, phone, password_hash, is_active, created_at, updated_at) VALUES(?,?,?,?,1,datetime('now'),datetime('now'))`).run(name.trim(), cleanEmail, phone?.trim() || null, hash);
  const token = jwt.sign({ sub: r.lastInsertRowid, type: 'candidate' }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('portal_token', token, { httpOnly: true, maxAge: 7 * 24 * 3600000, sameSite: 'lax' });
  res.json({ ok: true, token, candidate: { id: r.lastInsertRowid, name: name.trim(), email: cleanEmail, phone: phone?.trim() || null } });
});

// GET /api/portal/catalog — catalog for logged-in candidates (same data as public catalog)
router.get('/catalog', candidateAuth, (req, res) => {
  const db = getDb();
  const exams = db.prepare(`SELECT id, code, title, catalog_description, catalog_image, branding_color,
    duration_minutes, total_marks, pass_marks, is_open_test
    FROM exams WHERE is_public=1 AND status='published' ORDER BY title`).all();
  res.json(exams);
});

// POST /api/portal/request-access — logged-in candidate requests exam access (no name/email needed)
router.post('/request-access', candidateAuth, (req, res) => {
  const db = getDb();
  const { exam_id, message } = req.body;
  if (!exam_id) return res.status(400).json({ error: 'exam_id is required' });

  const candidate = db.prepare('SELECT id, name, email FROM candidates WHERE id=?').get(req.candidateId);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

  const exam = db.prepare(`SELECT id, title, is_open_test, status, is_public FROM exams WHERE id=?`).get(parseInt(exam_id));
  if (!exam || exam.status !== 'published' || !exam.is_public)
    return res.status(404).json({ error: 'Exam not found or not available' });

  if (exam.is_open_test) {
    const { generateToken } = require('../utils/linkgen');
    const token = generateToken();
    const expires_at = new Date(Date.now() + 72 * 3600000).toISOString();
    db.prepare(`INSERT INTO exam_links(token, exam_id, candidate_name, candidate_email, expires_at) VALUES(?,?,?,?,?)`)
      .run(token, exam.id, candidate.name, candidate.email, expires_at);
    return res.json({ open_test: true, url: buildExamUrl(token) });
  }

  const existing = db.prepare(`SELECT id FROM exam_access_requests WHERE exam_id=? AND email=? AND status='pending'`)
    .get(exam.id, candidate.email);
  if (existing) return res.status(409).json({ error: 'You already have a pending request for this exam.' });

  // Only block if the candidate has a link that is still usable (not yet started, or currently in-progress)
  // Cancelled / expired / revoked links do not block a new request
  const alreadyApproved = db.prepare(`
    SELECT el.id FROM exam_links el
    WHERE el.exam_id=? AND el.candidate_email=? AND el.is_revoked=0
      AND (el.expires_at IS NULL OR datetime(el.expires_at) > datetime('now'))
      AND (
        el.is_used=0
        OR EXISTS(SELECT 1 FROM submissions s WHERE s.link_id=el.id AND s.status='in_progress')
      )
  `).get(exam.id, candidate.email);
  if (alreadyApproved) return res.status(409).json({ error: 'You already have an active link for this exam. Check your My Exams tab.' });

  db.prepare(`INSERT INTO exam_access_requests(exam_id, name, email, message) VALUES(?,?,?,?)`)
    .run(exam.id, candidate.name, candidate.email, message?.trim() || null);

  res.json({ ok: true });

  setImmediate(async () => {
    try {
      const tmpl = db.prepare(`SELECT * FROM email_templates WHERE code='access_request_received' AND is_active=1`).get();
      if (!tmpl) return;
      const html = tmpl.body_html
        .replace(/\{\{candidate_name\}\}/g, candidate.name)
        .replace(/\{\{exam_title\}\}/g, exam.title)
        .replace(/\{\{platform_name\}\}/g, 'Alaric Exam');
      await sendEmail({ to: candidate.email, subject: tmpl.subject.replace(/\{\{exam_title\}\}/g, exam.title), html, templateCode: 'access_request_received', purpose: 'access_request_received' });
    } catch (e) { console.error('[portal] request-access email error:', e.message); }
  });
});

module.exports = router;
