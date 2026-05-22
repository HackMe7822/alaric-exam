const axios = require('axios');
const { getDb } = require('../../database/index');

function getSmsConfig() {
  const db = getDb();
  const keys = ['sms_provider', 'sms_account_sid', 'sms_auth_token', 'sms_from', 'sms_api_key', 'sms_enabled'];
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`
  ).all(...keys);
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  // Fall back to environment variables if not set in DB
  if (!cfg.sms_provider)     cfg.sms_provider     = process.env.SMS_PROVIDER || 'twilio';
  if (!cfg.sms_account_sid)  cfg.sms_account_sid  = process.env.SMS_ACCOUNT_SID || '';
  if (!cfg.sms_auth_token)   cfg.sms_auth_token   = process.env.SMS_AUTH_TOKEN || '';
  if (!cfg.sms_from)         cfg.sms_from         = process.env.SMS_FROM || '';
  if (!cfg.sms_api_key)      cfg.sms_api_key      = process.env.SMS_API_KEY || '';
  if (cfg.sms_enabled === undefined || cfg.sms_enabled === '') {
    cfg.sms_enabled = process.env.SMS_ENABLED !== '0' ? '1' : '0';
  }
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

// Fast2SMS — works for Indian numbers (+91). Strips country code, uses 10-digit number.
async function sendViaFast2SMS(cfg, { to, body }) {
  const apiKey = cfg.sms_api_key;
  if (!apiKey) {
    throw new Error('Fast2SMS API key not configured. Add it in Admin → Settings → SMS Config.');
  }
  // Extract 10-digit Indian number from formats like "+91 9876543210" or "9876543210"
  const digits = to.replace(/\D/g, '');
  const number = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.slice(-10);
  if (number.length !== 10) {
    throw new Error(`Fast2SMS requires a 10-digit Indian mobile number. Got: ${to}`);
  }
  const resp = await axios.post(
    'https://www.fast2sms.com/dev/bulkV2',
    { route: 'q', message: body, language: 'english', flash: 0, numbers: number },
    {
      headers: { authorization: apiKey, 'Content-Type': 'application/json' },
      validateStatus: () => true,
    }
  );
  if (resp.status >= 400 || resp.data?.return === false) {
    const msg = resp.data?.message?.[0] || resp.data?.message || `HTTP ${resp.status}`;
    throw new Error(`Fast2SMS: ${msg}`);
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
  if (provider === 'fast2sms') return sendViaFast2SMS(cfg, { to, body });
  throw new Error(`Unknown SMS provider: ${provider}`);
}

async function testSmsConnection(cfg) {
  const provider = cfg.sms_provider || 'twilio';
  if (provider === 'twilio') {
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
  } else if (provider === 'fast2sms') {
    if (!cfg.sms_api_key) throw new Error('API key is required');
    const resp = await axios.get('https://www.fast2sms.com/dev/wallet', {
      headers: { authorization: cfg.sms_api_key },
      validateStatus: () => true,
    });
    if (resp.status === 401 || resp.data?.return === false) {
      throw new Error('Invalid API key — check your Fast2SMS API key');
    }
    if (resp.status >= 400) throw new Error(`Fast2SMS API error: HTTP ${resp.status}`);
    const balance = resp.data?.wallet || 'unknown';
    return { message: `Credentials valid. Wallet balance: ₹${balance}` };
  }
}

module.exports = { sendSms, getSmsConfig, testSmsConnection };
