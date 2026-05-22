const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/roles');

// ── Public routes (no auth) ─────────────────────────────────────────────────

// GET /api/geo/countries
router.get('/countries', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, name, iso2, phone_code FROM geo_countries WHERE is_active=1 ORDER BY sort_order, name'
    ).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/geo/states?country_id=X
router.get('/states', (req, res) => {
  try {
    const db = getDb();
    const { country_id } = req.query;
    if (!country_id) return res.json([]);
    const rows = db.prepare(
      'SELECT id, name, code FROM geo_states WHERE country_id=? AND is_active=1 ORDER BY name'
    ).all(country_id);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/geo/cities?state_id=X
router.get('/cities', (req, res) => {
  try {
    const db = getDb();
    const { state_id } = req.query;
    if (!state_id) return res.json([]);
    const rows = db.prepare(
      'SELECT id, name FROM geo_cities WHERE state_id=? AND is_active=1 ORDER BY name'
    ).all(state_id);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin CRUD routes (require auth + super admin) ──────────────────────────

// GET /api/geo/countries/:id/states  (includes inactive, for admin)
router.get('/countries/:id/states', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, name, code, is_active FROM geo_states WHERE country_id=? ORDER BY name'
    ).all(req.params.id);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/geo/countries
router.post('/countries', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { name, iso2, phone_code, sort_order, is_active } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = db.prepare(
      'INSERT INTO geo_countries(name, iso2, phone_code, sort_order, is_active) VALUES(?,?,?,?,?)'
    ).run(name, iso2 || null, phone_code || null, sort_order || 0, is_active !== false ? 1 : 0);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/geo/countries/:id
router.put('/countries/:id', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { name, iso2, phone_code, sort_order, is_active } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    db.prepare(
      'UPDATE geo_countries SET name=?, iso2=?, phone_code=?, sort_order=?, is_active=? WHERE id=?'
    ).run(name, iso2 || null, phone_code || null, sort_order || 0, is_active !== false ? 1 : 0, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/geo/countries/:id
router.delete('/countries/:id', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM geo_countries WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/geo/states/:id/cities  (includes inactive, for admin)
router.get('/states/:id/cities', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, name, is_active FROM geo_cities WHERE state_id=? ORDER BY name'
    ).all(req.params.id);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/geo/states
router.post('/states', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { country_id, name, code, is_active } = req.body;
    if (!country_id || !name) return res.status(400).json({ error: 'country_id and name are required' });
    const result = db.prepare(
      'INSERT INTO geo_states(country_id, name, code, is_active) VALUES(?,?,?,?)'
    ).run(country_id, name, code || null, is_active !== false ? 1 : 0);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/geo/states/:id
router.put('/states/:id', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { name, code, is_active } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    db.prepare(
      'UPDATE geo_states SET name=?, code=?, is_active=? WHERE id=?'
    ).run(name, code || null, is_active !== false ? 1 : 0, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/geo/states/:id
router.delete('/states/:id', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM geo_states WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/geo/cities
router.post('/cities', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { state_id, country_id, name, is_active } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = db.prepare(
      'INSERT INTO geo_cities(state_id, country_id, name, is_active) VALUES(?,?,?,?)'
    ).run(state_id || null, country_id || null, name, is_active !== false ? 1 : 0);
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/geo/cities/:id
router.put('/cities/:id', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    const { name, is_active } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    db.prepare(
      'UPDATE geo_cities SET name=?, is_active=? WHERE id=?'
    ).run(name, is_active !== false ? 1 : 0, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/geo/cities/:id
router.delete('/cities/:id', auth, requireSuperAdmin, (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM geo_cities WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
