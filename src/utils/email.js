const nodemailer = require('nodemailer');
const axios = require('axios');
const { getDb } = require('../../database/index');

// ── Profile resolution ────────────────────────────────────────────────────

function getProfileForPurpose(purpose) {
  const db = getDb();
  if (purpose) {
    const routed = db.prepare(
      `SELECT p.* FROM email_profiles p
       JOIN email_routing r ON r.profile_id = p.id
       WHERE r.purpose = ? AND p.is_active = 1`
    ).get(purpose);
    if (routed) return { ...routed, _src: 'profile' };
  }
  const def = db.prepare(`SELECT * FROM email_profiles WHERE is_default=1 AND is_active=1`).get();
  if (def) return { ...def, _src: 'profile' };
  const any = db.prepare(`SELECT * FROM email_profiles WHERE is_active=1 ORDER BY id ASC LIMIT 1`).get();
  if (any) return { ...any, _src: 'profile' };
  const legacy = db.prepare(`SELECT * FROM email_config ORDER BY id DESC LIMIT 1`).get();
  return legacy ? { ...legacy, _src: 'legacy' } : null;
}

function getConfig() {
  return getProfileForPurpose(null);
}

// ── Internal log helpers ──────────────────────────────────────────────────

function _insertLog(db, { templateCode, to, subject, html, fromEmail, profileId }) {
  try {
    const r = db.prepare(
      `INSERT INTO email_log(template_code, to_email, subject, html_body, from_email, status, profile_id, sent_at)
       VALUES(?,?,?,?,?,'pending',?,datetime('now'))`
    ).run(templateCode || null, to || null, subject || null, html || null, fromEmail || null, profileId || null);
    return r.lastInsertRowid;
  } catch (e) {
    console.error('[EMAIL] Pre-log insert failed:', e.message, '| table may not exist yet');
    return null;
  }
}

function _updateLog(db, logId, status, errorMsg) {
  if (!logId) return;
  try {
    db.prepare(`UPDATE email_log SET status=?, error_message=? WHERE id=?`).run(status, errorMsg || null, logId);
  } catch (e) {
    console.error('[EMAIL] Log update failed:', e.message);
  }
}

// Standalone event logger — for "template not found", "skipped", etc.
function logEmailEvent({ templateCode, to, subject, html, purpose, status, errorMsg, profileId }) {
  const db = getDb();
  let resolvedProfileId = profileId || null;
  let fromEmail = null;
  if (!resolvedProfileId) {
    try {
      const cfg = getProfileForPurpose(purpose);
      if (cfg?._src === 'profile') resolvedProfileId = cfg.id;
      fromEmail = cfg?.from_email || null;
    } catch (_) {}
  }
  const logId = _insertLog(db, { templateCode, to, subject, html, fromEmail, profileId: resolvedProfileId });
  _updateLog(db, logId, status, errorMsg);
}

// ── Transport helpers ────────────────────────────────────────────────────

async function getAzureToken(cfg) {
  const url = `https://login.microsoftonline.com/${cfg.tenant_id}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const resp = await axios.post(url, params.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return resp.data.access_token;
}

async function sendViaAzure(cfg, { to, subject, html, cc, bcc }) {
  const token = await getAzureToken(cfg);
  const toList = Array.isArray(to) ? to : [to];
  const msg = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: toList.map(a => ({ emailAddress: { address: a } })),
      ...(cc?.length ? { ccRecipients: (Array.isArray(cc) ? cc : [cc]).map(a => ({ emailAddress: { address: a } })) } : {}),
      ...(bcc?.length ? { bccRecipients: (Array.isArray(bcc) ? bcc : [bcc]).map(a => ({ emailAddress: { address: a } })) } : {}),
    },
    saveToSentItems: false,
  };
  await axios.post(`https://graph.microsoft.com/v1.0/users/${cfg.from_email}/sendMail`, msg, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

async function sendViaSmtp(cfg, { to, subject, html, cc, bcc }) {
  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: cfg.smtp_port || 587,
    secure: cfg.smtp_secure === 1 || cfg.smtp_secure === true,
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass } : undefined,
    tls: { rejectUnauthorized: false },
    family: 4,
    connectionTimeout: 20000,
    socketTimeout: 30000,
    greetingTimeout: 15000,
  });
  await transporter.sendMail({
    from: cfg.from_name ? `"${cfg.from_name}" <${cfg.from_email}>` : cfg.from_email,
    to: Array.isArray(to) ? to.join(', ') : to,
    cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
    bcc: bcc ? (Array.isArray(bcc) ? bcc.join(', ') : bcc) : undefined,
    subject,
    html,
  });
}

// ── Core send function ────────────────────────────────────────────────────
// DESIGN: writes a 'pending' log row SYNCHRONOUSLY before touching SMTP,
// then updates it to 'sent' or 'failed'. Every attempt is always in the log.

async function sendEmail({ to, subject, html, cc, bcc, templateCode, purpose }) {
  const db = getDb();
  const toAddr = Array.isArray(to) ? to[0] : to;

  // Resolve profile (don't throw yet — log first)
  let cfg = null;
  try {
    cfg = getProfileForPurpose(purpose);
  } catch (e) {
    console.error('[EMAIL] Profile resolution error:', e.message);
  }

  const profileId   = cfg?._src === 'profile' ? cfg.id : null;
  const fromEmail   = cfg?.from_email || null;

  // Write the log entry immediately — before any network call
  const logId = _insertLog(db, { templateCode, to: toAddr, subject, html, fromEmail, profileId });
  console.log(`[EMAIL] queued logId=${logId} template=${templateCode} to=${toAddr} profile=${profileId}`);

  // Validate config — update log and throw
  if (!cfg) {
    const msg = 'No email account configured. Add one in Email Config → Email Accounts.';
    console.error('[EMAIL]', msg);
    _updateLog(db, logId, 'failed', msg);
    throw new Error(msg);
  }
  if (cfg._src === 'legacy' && !cfg.is_active) {
    const msg = 'Email account not active. Go to Email Config and activate an account.';
    console.error('[EMAIL]', msg);
    _updateLog(db, logId, 'failed', msg);
    throw new Error(msg);
  }

  // Attempt delivery
  let status = 'sent', errorMsg = null;
  try {
    console.log(`[EMAIL] sending via ${cfg.provider} host=${cfg.smtp_host || 'azure'} port=${cfg.smtp_port}`);
    if (cfg.provider === 'azure_graph') {
      await sendViaAzure(cfg, { to, subject, html, cc, bcc });
    } else {
      await sendViaSmtp(cfg, { to, subject, html, cc, bcc });
    }
    console.log(`[EMAIL] sent OK logId=${logId}`);
  } catch (err) {
    status = 'failed';
    errorMsg = err.message;
    console.error(`[EMAIL] send failed logId=${logId}:`, err.message);
    throw err;
  } finally {
    _updateLog(db, logId, status, errorMsg);
  }
}

// ── Template helper ────────────────────────────────────────────────────────

function renderTemplate(bodyHtml, vars) {
  return bodyHtml.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

async function sendTemplate(templateCode, to, vars = {}, purpose) {
  const db = getDb();
  const tmpl = db.prepare(`SELECT * FROM email_templates WHERE code=? AND is_active=1`).get(templateCode);
  if (!tmpl) throw new Error(`Template '${templateCode}' not found or inactive`);
  const html = renderTemplate(tmpl.body_html || '', { platform_name: 'Alaric Exam', year: new Date().getFullYear(), ...vars });
  const subject = renderTemplate(tmpl.subject || '', vars);
  await sendEmail({ to, subject, html, templateCode, purpose });
}

// ── Connection tester ─────────────────────────────────────────────────────

async function testConnection(cfg) {
  if (cfg.provider === 'azure_graph') {
    if (!cfg.tenant_id || !cfg.client_id || !cfg.client_secret) throw new Error('Tenant ID, Client ID and Client Secret are required');
    await getAzureToken(cfg);
  } else {
    if (!cfg.smtp_host) throw new Error('SMTP host is required');
    if (!cfg.smtp_user) throw new Error('SMTP username is required');
    if (!cfg.smtp_pass) throw new Error('SMTP password is required');
    const isSecure = cfg.smtp_secure === 1 || cfg.smtp_secure === true;
    const transporter = nodemailer.createTransport({
      host: cfg.smtp_host,
      port: cfg.smtp_port || (isSecure ? 465 : 587),
      secure: isSecure,
      auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
      tls: { rejectUnauthorized: false },
      family: 4,
      connectionTimeout: 12000,
      socketTimeout: 12000,
    });
    await new Promise((resolve, reject) => {
      transporter.sendMail({
        from: cfg.from_email || cfg.smtp_user,
        to: cfg.from_email || cfg.smtp_user,
        subject: 'Alaric Exam — Connection Test',
        text: 'SMTP connection test from Alaric Exam. If you received this, your email config is working correctly.',
      }, (err, info) => {
        transporter.close();
        if (err) {
          const msg = err.message || '';
          if (msg.includes('451')) reject(new Error('SMTP AUTH is disabled. In Microsoft 365: Admin Center → Users → select user → Mail → Manage email apps → enable Authenticated SMTP.'));
          else if (msg.includes('530') || msg.includes('535') || msg.includes('534')) reject(new Error('Authentication failed — wrong username/password, or for Gmail: use an App Password (not your regular password).'));
          else if (msg.includes('587') && msg.includes('530')) reject(new Error('Port 587 failed. Try port 465 with SSL enabled instead.'));
          else reject(err);
        } else {
          resolve(info);
        }
      });
    });
  }
}

module.exports = { sendEmail, sendTemplate, testConnection, getConfig, getProfileForPurpose, logEmailEvent };
