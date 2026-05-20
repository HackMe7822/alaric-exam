const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');
const { generateToken, buildExamUrl } = require('../utils/linkgen');
const { sendEmail, logEmailEvent } = require('../utils/email');

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

// POST /api/catalog/request-access — public, no auth required
router.post('/request-access', (req, res) => {
  const db = getDb();
  const { exam_id, name, email, message } = req.body;
  if (!exam_id || !name || !email) return res.status(400).json({ error: 'exam_id, name, and email are required' });

  const exam = db.prepare(`SELECT id, title, is_open_test, status, is_public FROM exams WHERE id=?`).get(parseInt(exam_id));
  if (!exam || exam.status !== 'published' || !exam.is_public) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  // If open test, generate link directly and return it
  if (exam.is_open_test) {
    const token = generateToken();
    const expires_at = new Date(Date.now() + 72 * 3600000).toISOString();
    db.prepare(`INSERT INTO exam_links(token, exam_id, candidate_name, candidate_email, expires_at)
      VALUES(?,?,?,?,?)`)
      .run(token, exam.id, name.trim(), email.trim().toLowerCase(), expires_at);
    return res.json({ open_test: true, url: buildExamUrl(token) });
  }

  // Check if a pending request already exists for this email + exam
  const existing = db.prepare(`SELECT id FROM exam_access_requests WHERE exam_id=? AND email=? AND status='pending'`)
    .get(exam.id, email.trim().toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'A pending request already exists for this email.' });
  }

  db.prepare(`INSERT INTO exam_access_requests(exam_id, name, email, message) VALUES(?,?,?,?)`)
    .run(exam.id, name.trim(), email.trim().toLowerCase(), message?.trim() || null);

  // Respond immediately, send confirmation email in background
  res.json({ ok: true });

  const cleanName  = name.trim();
  const cleanEmail = email.trim().toLowerCase();

  setImmediate(async () => {
    console.log(`[catalog] sending confirmation to ${cleanEmail} for exam ${exam.title}`);
    try {
      const tmpl = db.prepare(`SELECT * FROM email_templates WHERE code='access_request_received' AND is_active=1`).get();
      if (!tmpl) {
        console.error("[catalog] template 'access_request_received' not found");
        logEmailEvent({ templateCode: 'access_request_received', to: cleanEmail, status: 'failed',
          errorMsg: `Template 'access_request_received' not found or inactive`, purpose: 'access_request_received' });
        return;
      }
      const html = tmpl.body_html
        .replace(/\{\{candidate_name\}\}/g, cleanName)
        .replace(/\{\{exam_title\}\}/g, exam.title)
        .replace(/\{\{platform_name\}\}/g, 'Alaric Exam');
      const subject = tmpl.subject.replace(/\{\{exam_title\}\}/g, exam.title);
      await sendEmail({ to: cleanEmail, subject, html, templateCode: 'access_request_received', purpose: 'access_request_received' });
    } catch (e) {
      console.error('[catalog] confirmation email error:', e.message);
    }
  });
});

module.exports = router;
