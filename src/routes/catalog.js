const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getDb } = require('../../database/index');
const { generateToken, buildExamUrl } = require('../utils/linkgen');
const { sendEmail, logEmailEvent } = require('../utils/email');

// GET /api/catalog/config — public config (reCAPTCHA site key etc.)
router.get('/config', (req, res) => {
  res.json({ recaptcha_site_key: process.env.RECAPTCHA_SITE_KEY || null });
});

// GET /api/catalog/exam/:id — public exam info for registration page
router.get('/exam/:id', (req, res) => {
  const db = getDb();
  const setting = db.prepare(`SELECT value FROM settings WHERE key='allow_public_catalog'`).get();
  if (setting?.value !== '1') return res.status(404).json({ error: 'Exam not found' });
  const exam = db.prepare(`SELECT id, code, title, catalog_description, branding_logo, branding_color,
    duration_minutes, total_marks, pass_marks, is_open_test
    FROM exams WHERE id=? AND is_public=1 AND status='published'`).get(parseInt(req.params.id));
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  res.json(exam);
});

// GET /api/catalog — public exam catalog
router.get('/', (req, res) => {
  const db = getDb();
  const setting = db.prepare(`SELECT value FROM settings WHERE key='allow_public_catalog'`).get();
  if (setting?.value !== '1') return res.json([]);
  const exams = db.prepare(`SELECT id, code, title, catalog_description, branding_logo, branding_color,
    duration_minutes, total_marks, pass_marks, is_open_test
    FROM exams WHERE is_public=1 AND status='published' ORDER BY title`).all();
  res.json(exams);
});

// POST /api/catalog/begin-registration — validate, verify CAPTCHA, send OTP
router.post('/begin-registration', async (req, res) => {
  const db = getDb();
  const { exam_id, name, email, phone, message, captcha_token } = req.body;

  if (!exam_id || !name || !email || !phone) {
    return res.status(400).json({ error: 'Name, email, and phone are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const exam = db.prepare(`SELECT id, title, is_open_test, status, is_public FROM exams WHERE id=?`).get(parseInt(exam_id));
  if (!exam || exam.status !== 'published' || !exam.is_public) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  // Verify reCAPTCHA if configured
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (secret) {
    if (!captcha_token) return res.status(400).json({ error: 'Please complete the CAPTCHA verification.' });
    try {
      const verifyResp = await axios.post('https://www.google.com/recaptcha/api/siteverify', null, {
        params: { secret, response: captcha_token, remoteip: req.ip },
      });
      if (!verifyResp.data.success) {
        return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
      }
    } catch (e) {
      console.error('[catalog] reCAPTCHA error:', e.message);
    }
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanName  = name.trim();
  const cleanPhone = phone.trim();

  // Rate limit: 1 OTP per email per 60 seconds
  const recent = db.prepare(
    `SELECT id FROM email_otps WHERE email=? AND purpose='access_request' AND datetime(created_at) > datetime('now','-60 seconds')`
  ).get(cleanEmail);
  if (recent) return res.status(429).json({ error: 'Please wait 60 seconds before requesting another code.' });

  // For non-open tests: check if already has approved/pending request
  if (!exam.is_open_test) {
    const existing = db.prepare(
      `SELECT id FROM exam_access_requests WHERE exam_id=? AND email=? AND status IN ('pending','approved')`
    ).get(exam.id, cleanEmail);
    if (existing) return res.status(409).json({ error: 'You already have a pending or approved request for this exam.' });
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires_at = new Date(Date.now() + 10 * 60000).toISOString();
  const payload = JSON.stringify({
    exam_id: exam.id,
    name: cleanName,
    phone: cleanPhone,
    message: message?.trim() || null,
    ip_address: req.ip || null,
  });

  // Replace any old OTP for this email
  db.prepare(`DELETE FROM email_otps WHERE email=? AND purpose='access_request'`).run(cleanEmail);
  const r = db.prepare(
    `INSERT INTO email_otps(email, otp_code, expires_at, purpose, payload) VALUES(?,?,?,?,?)`
  ).run(cleanEmail, otp, expires_at, 'access_request', payload);

  res.json({ ok: true, otp_id: r.lastInsertRowid, email_hint: cleanEmail.replace(/(.{2}).+(@.+)/, '$1***$2') });

  // Send OTP email in background
  setImmediate(async () => {
    try {
      const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px">
        <h2 style="color:#4f46e5;margin-bottom:4px">Verify your email</h2>
        <p style="color:#374151">Hi ${cleanName},</p>
        <p style="color:#374151">Your verification code for <strong>${exam.title}</strong> is:</p>
        <div style="background:#f3f4f6;border-radius:12px;padding:28px;text-align:center;margin:24px 0">
          <span style="font-size:40px;font-weight:800;letter-spacing:10px;color:#111827;font-family:monospace">${otp}</span>
        </div>
        <p style="color:#6b7280;font-size:14px">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        <p style="color:#6b7280;font-size:14px">If you did not request exam access, please ignore this email.</p>
      </div>`;
      await sendEmail({
        to: cleanEmail,
        subject: `${otp} is your Alaric Exam verification code`,
        html,
        templateCode: 'email_otp',
        purpose: 'system',
      });
    } catch (e) {
      console.error('[catalog] OTP email error:', e.message);
    }
  });
});

// POST /api/catalog/verify-otp — verify code, create access request
router.post('/verify-otp', async (req, res) => {
  const db = getDb();
  const { otp_id, otp_code } = req.body;
  if (!otp_id || !otp_code) return res.status(400).json({ error: 'otp_id and otp_code are required' });

  const record = db.prepare(`SELECT * FROM email_otps WHERE id=?`).get(parseInt(otp_id));
  if (!record) return res.status(400).json({ error: 'Verification session expired. Please start over.' });

  if (new Date(record.expires_at) < new Date()) {
    db.prepare(`DELETE FROM email_otps WHERE id=?`).run(record.id);
    return res.status(400).json({ error: 'Code has expired. Please start over.', expired: true });
  }

  if (record.attempts >= 3) {
    db.prepare(`DELETE FROM email_otps WHERE id=?`).run(record.id);
    return res.status(400).json({ error: 'Too many incorrect attempts. Please start over.', expired: true });
  }

  if (record.otp_code !== otp_code.trim()) {
    db.prepare(`UPDATE email_otps SET attempts=attempts+1 WHERE id=?`).run(record.id);
    const remaining = 2 - record.attempts;
    return res.status(400).json({ error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` });
  }

  // OTP valid
  const payload = JSON.parse(record.payload);
  const { exam_id, name, phone, message, ip_address } = payload;
  db.prepare(`DELETE FROM email_otps WHERE id=?`).run(record.id);

  const exam = db.prepare(`SELECT id, title, is_open_test FROM exams WHERE id=?`).get(exam_id);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  if (exam.is_open_test) {
    const token = generateToken();
    const expires_at = new Date(Date.now() + 72 * 3600000).toISOString();
    db.prepare(`INSERT INTO exam_links(token, exam_id, candidate_name, candidate_email, expires_at) VALUES(?,?,?,?,?)`)
      .run(token, exam.id, name, record.email, expires_at);
    return res.json({ ok: true, open_test: true, url: buildExamUrl(token) });
  }

  // Create verified access request
  db.prepare(`INSERT INTO exam_access_requests(exam_id, name, email, phone, message, email_verified, ip_address) VALUES(?,?,?,?,?,1,?)`)
    .run(exam_id, name, record.email, phone, message, ip_address || req.ip);

  res.json({ ok: true });

  // Send confirmation email in background
  setImmediate(async () => {
    try {
      const tmpl = db.prepare(`SELECT * FROM email_templates WHERE code='access_request_received' AND is_active=1`).get();
      if (!tmpl) { logEmailEvent({ templateCode: 'access_request_received', to: record.email, status: 'failed', errorMsg: 'Template not found', purpose: 'access_request_received' }); return; }
      const html = tmpl.body_html
        .replace(/\{\{candidate_name\}\}/g, name)
        .replace(/\{\{exam_title\}\}/g, exam.title)
        .replace(/\{\{platform_name\}\}/g, 'Alaric Exam');
      const subject = tmpl.subject.replace(/\{\{exam_title\}\}/g, exam.title);
      await sendEmail({ to: record.email, subject, html, templateCode: 'access_request_received', purpose: 'access_request_received' });
    } catch (e) {
      console.error('[catalog] confirmation email error:', e.message);
    }
  });
});

// POST /api/catalog/request-access — legacy route (kept for backward compat + open tests)
router.post('/request-access', (req, res) => {
  const db = getDb();
  const { exam_id, name, email, message } = req.body;
  if (!exam_id || !name || !email) return res.status(400).json({ error: 'exam_id, name, and email are required' });

  const exam = db.prepare(`SELECT id, title, is_open_test, status, is_public FROM exams WHERE id=?`).get(parseInt(exam_id));
  if (!exam || exam.status !== 'published' || !exam.is_public) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  if (exam.is_open_test) {
    const token = generateToken();
    const expires_at = new Date(Date.now() + 72 * 3600000).toISOString();
    db.prepare(`INSERT INTO exam_links(token, exam_id, candidate_name, candidate_email, expires_at) VALUES(?,?,?,?,?)`)
      .run(token, exam.id, name.trim(), email.trim().toLowerCase(), expires_at);
    return res.json({ open_test: true, url: buildExamUrl(token) });
  }

  const cleanEmail = email.trim().toLowerCase();
  const existing = db.prepare(`SELECT id FROM exam_access_requests WHERE exam_id=? AND email=? AND status='pending'`)
    .get(exam.id, cleanEmail);
  if (existing) return res.status(409).json({ error: 'A pending request already exists for this email.' });

  db.prepare(`INSERT INTO exam_access_requests(exam_id, name, email, message) VALUES(?,?,?,?)`)
    .run(exam.id, name.trim(), cleanEmail, message?.trim() || null);

  res.json({ ok: true });

  const cleanName = name.trim();
  setImmediate(async () => {
    try {
      const tmpl = db.prepare(`SELECT * FROM email_templates WHERE code='access_request_received' AND is_active=1`).get();
      if (!tmpl) { logEmailEvent({ templateCode: 'access_request_received', to: cleanEmail, status: 'failed', errorMsg: 'Template not found', purpose: 'access_request_received' }); return; }
      const html = tmpl.body_html
        .replace(/\{\{candidate_name\}\}/g, cleanName)
        .replace(/\{\{exam_title\}\}/g, exam.title)
        .replace(/\{\{platform_name\}\}/g, 'Alaric Exam');
      await sendEmail({ to: cleanEmail, subject: tmpl.subject.replace(/\{\{exam_title\}\}/g, exam.title), html, templateCode: 'access_request_received', purpose: 'access_request_received' });
    } catch (e) {
      console.error('[catalog] confirmation email error:', e.message);
    }
  });
});

module.exports = router;
