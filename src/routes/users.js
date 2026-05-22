const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { audit } = require('../utils/audit');
const { softDelete } = require('../utils/recycle');

// GET /api/users
router.get('/', auth, requireRole('super_admin', 'exam_manager'), (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, email, full_name, role, is_active, last_login, created_at, totp_enabled FROM users ORDER BY full_name').all();
  res.json(users);
});

// POST /api/users — create
router.post('/', auth, requireRole('super_admin'), (req, res) => {
  const { username, email, full_name, role, password } = req.body;
  if (!username || !email || !full_name || !role || !password) return res.status(400).json({ error: 'All fields required' });
  const valid = ['super_admin', 'exam_manager', 'checker', 'viewer'];
  if (!valid.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const db = getDb();
  const hash = bcrypt.hashSync(password, 12);
  try {
    const result = db.prepare('INSERT INTO users(username, email, full_name, role, password_hash) VALUES(?,?,?,?,?)').run(username, email, full_name, role, hash);
    audit(req.user.id, 'create_user', 'user', result.lastInsertRowid, { username, role }, req);
    res.json({ id: result.lastInsertRowid, username, email, full_name, role });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username or email already exists' });
    throw e;
  }
});

// PUT /api/users/:id
router.put('/:id', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const { full_name, email, role, is_active } = req.body;
  const id = parseInt(req.params.id);

  // Prevent demoting/deactivating own super admin
  if (id === req.user.id && role && role !== 'super_admin') return res.status(400).json({ error: 'Cannot change own role' });

  const updates = [];
  const vals = [];
  if (full_name !== undefined) { updates.push('full_name=?'); vals.push(full_name); }
  if (email !== undefined) { updates.push('email=?'); vals.push(email); }
  if (role !== undefined) { updates.push('role=?'); vals.push(role); }
  if (is_active !== undefined) { updates.push('is_active=?'); vals.push(is_active ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  updates.push(`updated_at=datetime('now')`);
  vals.push(id);
  db.prepare(`UPDATE users SET ${updates.join(',')} WHERE id=?`).run(...vals);
  audit(req.user.id, 'update_user', 'user', id, req.body, req);
  res.json({ ok: true });
});

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', auth, requireRole('super_admin'), (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 chars' });
  const db = getDb();
  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, parseInt(req.params.id));
  audit(req.user.id, 'reset_password', 'user', parseInt(req.params.id), {}, req);
  res.json({ ok: true });
});

// DELETE /api/users/:id — soft delete to recycle bin
router.delete('/:id', auth, requireRole('super_admin'), (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete own account' });
  const db = getDb();
  const user = db.prepare('SELECT id, username, email, full_name, role, is_active, created_at FROM users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  softDelete(db, req.user.id, req.user.full_name || req.user.username, 'admin_user', id, user);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  audit(req.user.id, 'delete_admin_user', 'user', id, { username: user.username, email: user.email }, req);
  res.json({ ok: true });
});

module.exports = router;
