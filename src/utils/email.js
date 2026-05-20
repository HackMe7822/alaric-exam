const nodemailer = require('nodemailer');
const axios = require('axios');
const { getDb } = require('../../database/index');

// ── Profile resolution ────────────────────────────────────────────────────

function getProfileForPurpose(purpose) {
  const db = getDb();
  // 1. Purpose-specific routing
  if (purpose) {
    const routed = db.prepare(
      `SELECT p.* FROM email_profiles p
       JOIN email_routing r ON r.profile_id = p.id
       WHERE r.purpose = ? AND p.is_active = 1`
    ).get(purpose);
    if (routed) return { ...routed, _src: 'profile' };
  }
  // 2. Default active profile
  const def = db.prepare(`SELECT * FROM email_profiles WHERE is_default=1 AND is_active=1`).get();
  if (def) return { ...def, _src: 'profile' };
  // 3. Any active profile
  const any = db.prepare(`SELECT * FROM email_profiles WHERE is_active=1 ORDER BY id ASC LIMIT 1`).get();
  if (any) return { ...any, _src: 'profile' };
  // 4. Legacy fallback (email_config table)
  const legacy = db.prepare(`SELECT * FROM email_config ORDER BY id DESC LIMIT 1`).get();
  return legacy ? { ...legacy, _src: 'legacy' } : null;
}

// Keep backward-compat export for code that calls getConfig() directly
function getConfig() {
  return getProfileForPurpose(null);
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

// ── Standalone log writer — call this whenever you want to record an email event
// even without actually sending (e.g. template not found, config missing, skipped)
function logEmailEvent({ templateCode, to, subject, html, purpose, status, errorMsg, profileId }) {
  try {
    const db = getDb();
    let resolvedProfileId = profileId || null;
    let fromEmail = null;
    if (!resolvedProfileId && status !== 'skipped') {
      try {
        const cfg = getProfileForPurpose(purpose);
        if (cfg?._src === 'profile') resolvedProfileId = cfg.id;
        fromEmail = cfg?.from_email || null;
      } catch (_) {}
    }
    db.prepare(
      `INSERT INTO email_log(template_code, to_email, subject, html_body, from_email, status, error_message, profile_id, sent_at)
       VALUES(?,?,?,?,?,?,?,?,datetime('now'))`
    ).run(templateCode || null, to || null, subject || null, html || null, fromEmail, status, errorMsg || null, resolvedProfileId);
  } catch (e) {
    console.error('Failed to write email log:', e.message);
  }
}

// ── Core send function ────────────────────────────────────────────────────

async function sendEmail({ to, subject, html, cc, bcc, templateCode, purpose }) {
  const cfg = getProfileForPurpose(purpose);

  if (!cfg) throw new Error('No email account configured. Add one in Email Config → Email Accounts.');

  // Legacy email_config still requires explicit is_active=1
  if (cfg._src === 'legacy' && !cfg.is_active) {
    throw new Error('Email not configured or not active. Go to Email Config and activate an account.');
  }

  const db = getDb();
  let status = 'sent', errorMsg = null;

  try {
    if (cfg.provider === 'azure_graph') {
      await sendViaAzure(cfg, { to, subject, html, cc, bcc });
    } else {
      await sendViaSmtp(cfg, { to, subject, html, cc, bcc });
    }
  } catch (err) {
    status = 'failed';
    errorMsg = err.message;
    throw err;
  } finally {
    const toAddr = Array.isArray(to) ? to[0] : to;
    logEmailEvent({
      templateCode, to: toAddr, subject, html, purpose,
      status, errorMsg,
      profileId: cfg._src === 'profile' ? cfg.id : null,
    });
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
          if (msg.includes('451')) reject(new Error('SMTP AUTH is disabled for this mailbox. In Microsoft 365: Admin Center → Users → select user → Mail → Manage email apps → enable Authenticated SMTP.'));
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
