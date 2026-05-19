const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { audit } = require('../utils/audit');

// POST /api/auth/login
router.post('/login', authLimiter, (req, res) => {
  const { username, password, totp_code } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE (username=? OR email=?) AND is_active=1').get(username, username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    audit(null, 'login_fail', 'user', user.id, { username }, req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (user.totp_enabled) {
    if (!totp_code) return res.status(200).json({ require_totp: true });
    const verified = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: totp_code,
      window: 1
    });
    if (!verified) return res.status(401).json({ error: 'Invalid 2FA code' });
  }

  const jti = uuidv4();
  const token = jwt.sign({ sub: user.id, jti, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '8h' });
  const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();

  db.prepare('INSERT INTO sessions(user_id, jti, expires_at, ip_address, user_agent) VALUES(?,?,?,?,?)')
    .run(user.id, jti, expiresAt, req.ip, req.headers['user-agent']);
  db.prepare(`UPDATE users SET last_login=datetime('now') WHERE id=?`).run(user.id);

  audit(user.id, 'login', 'user', user.id, {}, req);

  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 });
  res.json({
    token,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, email: user.email, totp_enabled: user.totp_enabled }
  });
});

// POST /api/auth/logout
router.post('/logout', auth, (req, res) => {
  const db = getDb();
  const payload = jwt.decode(req.token);
  if (payload?.jti) db.prepare('UPDATE sessions SET revoked=1 WHERE jti=?').run(payload.jti);
  res.clearCookie('token');
  audit(req.user.id, 'logout', 'user', req.user.id, {}, req);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, email: u.email, totp_enabled: u.totp_enabled });
});

// POST /api/auth/change-password
router.post('/change-password', auth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password incorrect' });

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare(`UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?`).run(hash, req.user.id);
  audit(req.user.id, 'change_password', 'user', req.user.id, {}, req);
  res.json({ ok: true });
});

// POST /api/auth/totp/setup
router.post('/totp/setup', auth, async (req, res) => {
  const secret = speakeasy.generateSecret({ name: `Alaric Exam (${req.user.email})`, issuer: 'Alaric Exam' });
  const qr = await QRCode.toDataURL(secret.otpauth_url);
  const db = getDb();
  db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(secret.base32, req.user.id);
  res.json({ qr, secret: secret.base32 });
});

// POST /api/auth/totp/verify
router.post('/totp/verify', auth, (req, res) => {
  const { code } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT totp_secret FROM users WHERE id=?').get(req.user.id);
  if (!user?.totp_secret) return res.status(400).json({ error: 'TOTP not set up' });

  const verified = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: code, window: 1 });
  if (!verified) return res.status(400).json({ error: 'Invalid code' });

  db.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(req.user.id);
  audit(req.user.id, 'totp_enabled', 'user', req.user.id, {}, req);
  res.json({ ok: true });
});

// POST /api/auth/totp/disable
router.post('/totp/disable', auth, (req, res) => {
  const { password } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Password incorrect' });
  db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?').run(req.user.id);
  audit(req.user.id, 'totp_disabled', 'user', req.user.id, {}, req);
  res.json({ ok: true });
});

module.exports = router;
