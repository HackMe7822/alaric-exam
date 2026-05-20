const nodemailer = require('nodemailer');
const axios = require('axios');
const { getDb } = require('../../database/index');

function getConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM email_config ORDER BY id DESC LIMIT 1').get();
}

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

async function sendEmail({ to, subject, html, cc, bcc, templateCode }) {
  const cfg = getConfig();
  if (!cfg || !cfg.is_active) throw new Error('Email not configured or not active');

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
    db.prepare('INSERT INTO email_log(template_code, to_email, subject, html_body, from_email, status, error_message) VALUES(?,?,?,?,?,?,?)')
      .run(templateCode || null, toAddr, subject, html || null, cfg.from_email || null, status, errorMsg);
  }
}

function renderTemplate(bodyHtml, vars) {
  return bodyHtml.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

async function sendTemplate(templateCode, to, vars = {}) {
  const db = getDb();
  const tmpl = db.prepare(`SELECT * FROM email_templates WHERE code=? AND is_active=1`).get(templateCode);
  if (!tmpl) throw new Error(`Template '${templateCode}' not found or inactive`);
  const html = renderTemplate(tmpl.body_html || '', { platform_name: 'Alaric Exam', year: new Date().getFullYear(), ...vars });
  const subject = renderTemplate(tmpl.subject || '', vars);
  await sendEmail({ to, subject, html, templateCode });
}

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

module.exports = { sendEmail, sendTemplate, testConnection, getConfig };
