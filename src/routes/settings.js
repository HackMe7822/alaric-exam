const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireRole, requireSuperAdmin } = require('../middleware/roles');
const { audit } = require('../utils/audit');
const { testConnection, getConfig, sendEmail } = require('../utils/email');
const nodemailer = require('nodemailer');
const axios = require('axios');

// GET /api/settings
router.get('/', auth, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value, description FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = { value: r.value, description: r.description };
  res.json(obj);
});

// PUT /api/settings — bulk update
router.put('/', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const updates = req.body; // {key: value, ...}
  const upd = db.prepare(`INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`);
  db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) upd.run(key, String(value), req.user.id);
  })();
  audit(req.user.id, 'update_settings', 'settings', null, updates, req);
  res.json({ ok: true });
});

// --- Email Config ---
// GET /api/settings/email-config
router.get('/email-config', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const cfg = db.prepare('SELECT * FROM email_config ORDER BY id DESC LIMIT 1').get();
  if (!cfg) return res.json({});
  const { client_secret, smtp_pass, ...safe } = cfg;
  res.json({ ...safe, has_secret: !!client_secret, has_smtp_pass: !!smtp_pass });
});

// PUT /api/settings/email-config
router.put('/email-config', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const { provider, tenant_id, client_id, client_secret, from_email, from_name, reply_to, default_cc, default_bcc,
    smtp_host, smtp_port, smtp_secure } = req.body;
  // Accept both field name variants from frontend
  const smtp_user = req.body.smtp_user || req.body.smtp_username || null;
  const smtp_pass_new = req.body.smtp_pass || req.body.smtp_password || null;

  const existing = db.prepare('SELECT id, client_secret, smtp_pass FROM email_config ORDER BY id DESC LIMIT 1').get();
  const secret = client_secret || (existing?.client_secret || null);
  const smtpP = smtp_pass_new || (existing?.smtp_pass || null);

  const ccVal = Array.isArray(default_cc) ? default_cc.join(',') : default_cc || null;
  const bccVal = Array.isArray(default_bcc) ? default_bcc.join(',') : default_bcc || null;

  if (existing) {
    db.prepare(`UPDATE email_config SET provider=?, tenant_id=?, client_id=?, client_secret=?, from_email=?, from_name=?,
      reply_to=?, default_cc=?, default_bcc=?, smtp_host=?, smtp_port=?, smtp_user=?, smtp_pass=?, smtp_secure=?,
      updated_by=?, updated_at=datetime('now') WHERE id=?`)
      .run(provider||'azure_graph', tenant_id||null, client_id||null, secret, from_email||null, from_name||null,
        reply_to||null, ccVal, bccVal, smtp_host||null, smtp_port||null, smtp_user,
        smtpP, smtp_secure?1:0, req.user.id, existing.id);
  } else {
    db.prepare(`INSERT INTO email_config(provider, tenant_id, client_id, client_secret, from_email, from_name,
      reply_to, default_cc, default_bcc, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(provider||'azure_graph', tenant_id||null, client_id||null, secret, from_email||null, from_name||null,
        reply_to||null, ccVal, bccVal, smtp_host||null, smtp_port||null, smtp_user,
        smtpP, smtp_secure?1:0, req.user.id);
  }
  audit(req.user.id, 'update_email_config', 'email_config', null, { provider, from_email }, req);
  res.json({ ok: true });
});

// POST /api/settings/email-config/activate  (toggles active/inactive)
router.post('/email-config/activate', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const { active } = req.body; // true = activate, false = deactivate; omit to toggle
  const current = db.prepare('SELECT is_active FROM email_config ORDER BY id DESC LIMIT 1').get();
  const newState = active !== undefined ? (active ? 1 : 0) : (current?.is_active ? 0 : 1);
  db.prepare('UPDATE email_config SET is_active=?').run(newState);
  res.json({ ok: true, is_active: newState });
});

// POST /api/settings/email-config/test
router.post('/email-config/test', auth, requireSuperAdmin, async (req, res) => {
  const db = getDb();
  const saved = db.prepare('SELECT * FROM email_config ORDER BY id DESC LIMIT 1').get();
  if (!saved) return res.status(400).json({ error: 'No email configuration found. Save your settings first.' });

  // Merge in any unsaved form values sent from the browser for live testing
  const { provider, tenant_id, client_id, client_secret, from_email, smtp_host, smtp_port, smtp_secure } = req.body;
  const smtp_user = req.body.smtp_user || req.body.smtp_username || saved.smtp_user;
  const smtp_pass = req.body.smtp_pass || req.body.smtp_password || saved.smtp_pass;

  const cfg = {
    ...saved,
    provider: provider || saved.provider,
    tenant_id: tenant_id || saved.tenant_id,
    client_id: client_id || saved.client_id,
    client_secret: client_secret || saved.client_secret,
    from_email: from_email || saved.from_email,
    smtp_host: smtp_host || saved.smtp_host,
    smtp_port: smtp_port || saved.smtp_port,
    smtp_user,
    smtp_pass,
    smtp_secure: smtp_secure !== undefined ? smtp_secure : saved.smtp_secure,
  };

  try {
    await testConnection(cfg);
    res.json({ ok: true, message: cfg.provider === 'azure_graph' ? 'Azure token acquired successfully' : 'SMTP connection verified' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/settings/email-config/send-test  — send a real email to verify delivery
router.post('/email-config/send-test', auth, requireSuperAdmin, async (req, res) => {
  const db = getDb();
  // Use profile system first, fall back to legacy email_config
  const saved = db.prepare('SELECT * FROM email_profiles WHERE is_default=1 AND is_active=1').get()
    || db.prepare('SELECT * FROM email_profiles WHERE is_active=1 ORDER BY id ASC LIMIT 1').get()
    || db.prepare('SELECT * FROM email_config ORDER BY id DESC LIMIT 1').get();
  if (!saved) return res.status(400).json({ error: 'No email configuration saved yet.' });

  const { to } = req.body;
  if (!to || !/\S+@\S+\.\S+/.test(to)) return res.status(400).json({ error: 'Valid recipient email required.' });

  const subject = `Alaric Exam — Test Email (${new Date().toLocaleString()})`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;border:1px solid #e2e8f0;border-radius:8px">
    <h2 style="color:#002B5C;margin:0 0 16px">Test Email</h2>
    <p style="color:#333;line-height:1.6">This is a test email sent from <strong>Alaric Exam</strong> to confirm your email configuration is working correctly.</p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
    <table style="font-size:13px;color:#555;width:100%">
      <tr><td style="padding:4px 0;font-weight:600;width:120px">Provider</td><td>${saved.provider === 'azure_graph' ? 'Azure Graph API' : 'SMTP'}</td></tr>
      <tr><td style="padding:4px 0;font-weight:600">From</td><td>${saved.from_email || '—'}</td></tr>
      <tr><td style="padding:4px 0;font-weight:600">Sent at</td><td>${new Date().toISOString()}</td></tr>
    </table>
    <p style="margin-top:20px;font-size:12px;color:#999">Sent by Alaric Exam Admin Panel</p>
  </div>`;

  let status = 'sent', errorMsg = null;
  try {
    if (saved.provider === 'azure_graph') {
      const tokenResp = await axios.post(
        `https://login.microsoftonline.com/${saved.tenant_id}/oauth2/v2.0/token`,
        new URLSearchParams({ client_id: saved.client_id, client_secret: saved.client_secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const token = tokenResp.data.access_token;
      await axios.post(`https://graph.microsoft.com/v1.0/users/${saved.from_email}/sendMail`, {
        message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] },
        saveToSentItems: false
      }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    } else {
      const transporter = nodemailer.createTransport({
        host: saved.smtp_host, port: saved.smtp_port || 587,
        secure: saved.smtp_secure === 1, tls: { rejectUnauthorized: false },
        auth: saved.smtp_user ? { user: saved.smtp_user, pass: saved.smtp_pass } : undefined,
      });
      await transporter.sendMail({
        from: saved.from_name ? `"${saved.from_name}" <${saved.from_email}>` : saved.from_email,
        to, subject, html,
      });
    }
  } catch (err) {
    status = 'failed';
    errorMsg = err.response?.data?.error?.message || err.message;
  }

  db.prepare('INSERT INTO email_log(template_code, to_email, subject, status, error_message) VALUES(?,?,?,?,?)')
    .run('test', to, subject, status, errorMsg);

  if (status === 'failed') return res.status(400).json({ error: errorMsg });
  res.json({ ok: true, message: `Test email sent to ${to}` });
});

// --- Email Templates ---
router.get('/email-templates', auth, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM email_templates ORDER BY name').all());
});

router.get('/email-templates/:code', auth, (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT * FROM email_templates WHERE code=?').get(req.params.code);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

router.put('/email-templates/:code', auth, requireRole('super_admin', 'exam_manager'), (req, res) => {
  const db = getDb();
  const { subject, body_html, is_active } = req.body;
  db.prepare(`UPDATE email_templates SET subject=?, body_html=?, is_active=?, updated_by=?, updated_at=datetime('now') WHERE code=?`)
    .run(subject, body_html, is_active!==false?1:0, req.user.id, req.params.code);
  res.json({ ok: true });
});

// --- Email Log ---
router.get('/email-log', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const { status, date, limit = 500 } = req.query;
  try {
    // Use subquery for profile_name — more resilient than JOIN if schema varies
    let sql = `SELECT id, template_code, to_email, subject, from_email, status, error_message, sent_at, created_at, profile_id,
         (SELECT name FROM email_profiles WHERE id=email_log.profile_id) as profile_name
       FROM email_log WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND status=?'; params.push(status); }
    if (date)   { sql += ' AND DATE(created_at)=?'; params.push(date); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    res.json(db.prepare(sql).all(...params));
  } catch (e) {
    // Fallback: simpler query without profile subquery
    console.error('email-log query error:', e.message);
    try {
      let sql2 = `SELECT id, template_code, to_email, subject, from_email, status, error_message, sent_at, created_at FROM email_log WHERE 1=1`;
      const p2 = [];
      if (date) { sql2 += ' AND DATE(created_at)=?'; p2.push(date); }
      sql2 += ' ORDER BY created_at DESC LIMIT ?';
      p2.push(parseInt(limit));
      res.json(db.prepare(sql2).all(...p2));
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

// GET /api/settings/email-log/:id — full entry including html_body
router.get('/email-log/:id', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM email_log WHERE id=?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// --- Audit Log ---
router.get('/audit-log', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const { page = 1, limit = 50, action, user_id, q, date } = req.query;
  let sql = 'SELECT al.*, u.full_name as user_name FROM audit_log al LEFT JOIN users u ON u.id=al.user_id WHERE 1=1';
  const params = [];
  if (action) { sql += ' AND al.action=?'; params.push(action); }
  if (user_id) { sql += ' AND al.user_id=?'; params.push(parseInt(user_id)); }
  if (q) { sql += ' AND (al.action LIKE ? OR al.resource_type LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (date) { sql += ' AND DATE(al.created_at)=?'; params.push(date); }
  sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json(db.prepare(sql).all(...params));
});

// --- API Keys ---
router.get('/api-keys', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT id, name, key_prefix, permissions, rate_limit, last_used, is_active, created_at, expires_at FROM api_keys ORDER BY created_at DESC').all());
});

router.post('/api-keys', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const { name, permissions, rate_limit, expires_at } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const crypto = require('crypto');
  const rawKey = 'ak_' + crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.substring(0, 10);
  db.prepare('INSERT INTO api_keys(name, key_hash, key_prefix, permissions, rate_limit, expires_at, created_by) VALUES(?,?,?,?,?,?,?)')
    .run(name, keyHash, keyPrefix, JSON.stringify(permissions||[]), rate_limit||1000, expires_at||null, req.user.id);
  res.json({ key: rawKey, prefix: keyPrefix });
});

router.delete('/api-keys/:id', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE api_keys SET is_active=0 WHERE id=?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// --- Webhooks ---
router.get('/webhooks', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all());
});

router.post('/webhooks', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const { name, url, events, secret } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
  const r = db.prepare('INSERT INTO webhooks(name, url, events, secret, created_by) VALUES(?,?,?,?,?)')
    .run(name, url, JSON.stringify(events||[]), secret||null, req.user.id);
  res.json({ id: r.lastInsertRowid });
});

router.delete('/webhooks/:id', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM webhooks WHERE id=?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// GDPR export
router.get('/gdpr-export/:candidateId', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.candidateId);
  const candidate = db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
  if (!candidate) return res.status(404).json({ error: 'Not found' });
  const submissions = db.prepare('SELECT * FROM submissions WHERE candidate_id=?').all(id);
  const links = db.prepare('SELECT * FROM exam_links WHERE candidate_id=?').all(id);
  const gamification = db.prepare('SELECT * FROM gamification WHERE candidate_id=?').all(id);
  const exported = { candidate, submissions, links, gamification, exported_at: new Date().toISOString() };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="gdpr-export-${id}.json"`);
  res.send(JSON.stringify(exported, null, 2));
});

// DELETE /api/settings/gdpr-erase/:candidateId
router.delete('/gdpr-erase/:candidateId', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.candidateId);
  if (!id) return res.status(400).json({ error: 'Valid candidate ID required' });
  const candidate = db.prepare('SELECT id FROM candidates WHERE id=?').get(id);
  if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
  db.transaction(() => {
    const subs = db.prepare('SELECT id FROM submissions WHERE candidate_id=?').all(id);
    for (const s of subs) {
      db.prepare('DELETE FROM answers WHERE submission_id=?').run(s.id);
      db.prepare('DELETE FROM review_assignments WHERE submission_id=?').run(s.id);
      db.prepare('DELETE FROM snapshots WHERE submission_id=?').run(s.id);
    }
    db.prepare('DELETE FROM submissions WHERE candidate_id=?').run(id);
    db.prepare('DELETE FROM exam_links WHERE candidate_id=?').run(id);
    db.prepare('DELETE FROM gamification WHERE candidate_id=?').run(id);
    db.prepare('DELETE FROM candidates WHERE id=?').run(id);
  })();
  audit(req.user.id, 'gdpr_erase', 'candidate', id, {}, req);
  res.json({ ok: true });
});

// ── Email Profiles ────────────────────────────────────────────────────────

// GET /api/settings/email-profiles
router.get('/email-profiles', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const profiles = db.prepare(
    `SELECT p.*,
       (SELECT GROUP_CONCAT(r.purpose) FROM email_routing r WHERE r.profile_id=p.id) as used_for
     FROM email_profiles p ORDER BY p.is_default DESC, p.id ASC`
  ).all();
  res.json(profiles.map(p => ({ ...p, client_secret: p.client_secret ? '••••••••' : null, smtp_pass: p.smtp_pass ? '••••••••' : null })));
});

// POST /api/settings/email-profiles
router.post('/email-profiles', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const { name, provider, tenant_id, client_id, client_secret, from_email, from_name, reply_to,
          smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const isFirst = !db.prepare('SELECT id FROM email_profiles LIMIT 1').get();
  const r = db.prepare(
    `INSERT INTO email_profiles(name,provider,tenant_id,client_id,client_secret,from_email,from_name,reply_to,
       smtp_host,smtp_port,smtp_user,smtp_pass,smtp_secure,is_default,is_active,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,datetime('now'))`
  ).run(name, provider||'smtp', tenant_id||null, client_id||null, client_secret||null,
        from_email||null, from_name||null, reply_to||null,
        smtp_host||null, smtp_port||null, smtp_user||null, smtp_pass||null,
        smtp_secure===false||smtp_secure===0 ? 0 : 1, isFirst ? 1 : 0);
  audit(req.user.id, 'create_email_profile', 'email_profiles', r.lastInsertRowid, { name }, req);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// PUT /api/settings/email-profiles/:id
router.put('/email-profiles/:id', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM email_profiles WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Profile not found' });
  const { name, provider, tenant_id, client_id, client_secret, from_email, from_name, reply_to,
          smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure } = req.body;
  const newSecret = (client_secret && client_secret !== '••••••••') ? client_secret : existing.client_secret;
  const newPass   = (smtp_pass && smtp_pass !== '••••••••')   ? smtp_pass   : existing.smtp_pass;
  db.prepare(
    `UPDATE email_profiles SET name=?,provider=?,tenant_id=?,client_id=?,client_secret=?,
       from_email=?,from_name=?,reply_to=?,smtp_host=?,smtp_port=?,smtp_user=?,smtp_pass=?,
       smtp_secure=?,updated_at=datetime('now') WHERE id=?`
  ).run(name||existing.name, provider||existing.provider, tenant_id||null, client_id||null, newSecret,
        from_email||null, from_name||null, reply_to||null,
        smtp_host||null, smtp_port||null, smtp_user||null, newPass,
        smtp_secure===false||smtp_secure===0 ? 0 : 1, id);
  audit(req.user.id, 'update_email_profile', 'email_profiles', id, { name }, req);
  res.json({ ok: true });
});

// DELETE /api/settings/email-profiles/:id
router.delete('/email-profiles/:id', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const p = db.prepare('SELECT * FROM email_profiles WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  const total = db.prepare('SELECT COUNT(*) as c FROM email_profiles').get().c;
  if (total <= 1) return res.status(400).json({ error: 'Cannot delete the only email account' });
  db.prepare('UPDATE email_routing SET profile_id=NULL WHERE profile_id=?').run(id);
  db.prepare('DELETE FROM email_profiles WHERE id=?').run(id);
  if (p.is_default) {
    const next = db.prepare('SELECT id FROM email_profiles ORDER BY id ASC LIMIT 1').get();
    if (next) db.prepare('UPDATE email_profiles SET is_default=1 WHERE id=?').run(next.id);
  }
  audit(req.user.id, 'delete_email_profile', 'email_profiles', id, { name: p.name }, req);
  res.json({ ok: true });
});

// POST /api/settings/email-profiles/:id/set-default
router.post('/email-profiles/:id/set-default', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM email_profiles WHERE id=?').get(id)) return res.status(404).json({ error: 'Profile not found' });
  db.prepare('UPDATE email_profiles SET is_default=0').run();
  db.prepare('UPDATE email_profiles SET is_default=1 WHERE id=?').run(id);
  audit(req.user.id, 'set_default_email_profile', 'email_profiles', id, {}, req);
  res.json({ ok: true });
});

// POST /api/settings/email-profiles/:id/toggle
router.post('/email-profiles/:id/toggle', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const p = db.prepare('SELECT * FROM email_profiles WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  const newState = p.is_active ? 0 : 1;
  db.prepare(`UPDATE email_profiles SET is_active=?,updated_at=datetime('now') WHERE id=?`).run(newState, id);
  res.json({ ok: true, is_active: newState });
});

// POST /api/settings/email-profiles/:id/test
router.post('/email-profiles/:id/test', auth, requireSuperAdmin, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const p = db.prepare('SELECT * FROM email_profiles WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  try {
    await testConnection(p);
    res.json({ ok: true, message: 'Connection successful' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/settings/email-profiles/:id/send-test-email
router.post('/email-profiles/:id/send-test-email', auth, requireSuperAdmin, async (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email (to) is required' });
  const p = db.prepare('SELECT * FROM email_profiles WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  try {
    await sendEmail({
      to,
      subject: 'Alaric Exam — Email Delivery Test',
      html: `<p>This is a delivery test from <strong>Alaric Exam</strong> using the account <strong>${p.name || p.from_email}</strong>.</p><p>If you received this, your email configuration is working correctly.</p>`,
      templateCode: 'delivery_test',
      purpose: null,
    });
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Email Routing ─────────────────────────────────────────────────────────

// GET /api/settings/email-routing
router.get('/email-routing', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT r.purpose, r.label, r.profile_id, p.name as profile_name
     FROM email_routing r LEFT JOIN email_profiles p ON p.id=r.profile_id
     ORDER BY r.rowid ASC`
  ).all();
  res.json(rows);
});

// PUT /api/settings/email-routing
router.put('/email-routing', auth, requireSuperAdmin, (req, res) => {
  const db = getDb();
  const updates = req.body;
  const upd = db.prepare('UPDATE email_routing SET profile_id=? WHERE purpose=?');
  db.transaction(() => {
    for (const [purpose, profileId] of Object.entries(updates)) {
      upd.run(profileId || null, purpose);
    }
  })();
  audit(req.user.id, 'update_email_routing', 'email_routing', null, updates, req);
  res.json({ ok: true });
});

module.exports = router;
