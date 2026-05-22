const axios = require('axios');
const { getDb } = require('../../database/index');

function getSmsConfig() {
  const db = getDb();
  const keys = ['sms_provider', 'sms_account_sid', 'sms_auth_token', 'sms_from', 'sms_enabled'];
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
  ).all(...keys);
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}

async function sendViaTwilio(cfg, { to, body }) {
  const { sms_account_sid, sms_auth_token, sms_from } = cfg;
  if (!sms_account_sid || !sms_auth_token || !sms_from) {
    throw new Error('Twilio not fully configured. Set Account SID, Auth Token and From number in Admin → Settings → SMS Config.');
  }
  const resp = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sms_account_sid}/Messages.json`,
    new URLSearchParams({ To: to, From: sms_from, Body: body }).toString(),
    {
      auth: { username: sms_account_sid, password: sms_auth_token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    }
  );
  if (resp.status >= 400) {
    const msg = resp.data?.message || `HTTP ${resp.status}`;
    throw new Error(`Twilio: ${msg}`);
  }
  return resp.data;
}

async function sendSms({ to, body }) {
  const cfg = getSmsConfig();
  if (cfg.sms_enabled === '0') {
    throw new Error('SMS is disabled. Enable it in Admin → Settings → SMS Config.');
  }
  const provider = cfg.sms_provider || 'twilio';
  if (provider === 'twilio') return sendViaTwilio(cfg, { to, body });
  throw new Error(`Unknown SMS provider: ${provider}`);
}

async function testSmsConnection(cfg) {
  if (!cfg.sms_account_sid || !cfg.sms_auth_token) {
    throw new Error('Account SID and Auth Token are required');
  }
  const resp = await axios.get(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.sms_account_sid}.json`,
    {
      auth: { username: cfg.sms_account_sid, password: cfg.sms_auth_token },
      validateStatus: () => true,
    }
  );
  if (resp.status === 401) throw new Error('Invalid credentials — check Account SID and Auth Token');
  if (resp.status >= 400) throw new Error(`Twilio API error: HTTP ${resp.status}`);
}

module.exports = { sendSms, getSmsConfig, testSmsConnection };
