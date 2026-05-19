const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');

// GET /api/catalog — public exam catalog
router.get('/', (req, res) => {
  const db = getDb();
  const setting = db.prepare(`SELECT value FROM settings WHERE key='allow_public_catalog'`).get();
  if (setting?.value !== '1') return res.json([]);

  const exams = db.prepare(`SELECT id, code, title, catalog_description, branding_logo, branding_color, duration_minutes, total_marks, pass_marks
    FROM exams WHERE is_public=1 AND status='published' ORDER BY title`).all();
  res.json(exams);
});

module.exports = router;
