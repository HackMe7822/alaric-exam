const express = require('express');
const router = express.Router();
const { getDb } = require('../../database/index');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { makeSummary } = require('../utils/recycle');

// GET /api/recycle — list all soft-deleted records
router.get('/', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const { type, search } = req.query;
  let sql = 'SELECT * FROM deleted_records WHERE 1=1';
  const params = [];
  if (type) { sql += ' AND record_type=?'; params.push(type); }
  if (search) { sql += ' AND (record_data LIKE ? OR deleted_by_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY deleted_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => {
    let parsed = {};
    try { parsed = JSON.parse(r.record_data); } catch {}
    return { ...r, _parsed: parsed, summary: makeSummary(r.record_type, parsed) };
  }));
});

// GET /api/recycle/stats — counts per type
router.get('/stats', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT record_type, COUNT(*) as count FROM deleted_records GROUP BY record_type').all();
  const total = db.prepare('SELECT COUNT(*) as count FROM deleted_records').get()?.count || 0;
  res.json({ total, byType: Object.fromEntries(rows.map(r => [r.record_type, r.count])) });
});

// GET /api/recycle/log — permanent deletion audit log
router.get('/log', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM deletion_log ORDER BY purged_at DESC LIMIT 200').all();
  res.json(rows);
});

// POST /api/recycle/:id/restore — restore a soft-deleted record
router.post('/:id/restore', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM deleted_records WHERE id=?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'Record not found in recycle bin' });
  let data = {};
  try { data = JSON.parse(row.record_data); } catch { return res.status(500).json({ error: 'Corrupt record data' }); }

  try {
    if (row.record_type === 'candidate') {
      db.prepare(`INSERT OR IGNORE INTO candidates(id,name,email,phone,department_id,employee_id,password_hash,
        is_active,organization,address,city,state,country,postal_code,photo,phone_verified,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,datetime('now'))`)
        .run(data.id,data.name,data.email,data.phone||null,data.department_id||null,data.employee_id||null,
          data.password_hash||null,data.organization||null,data.address||null,data.city||null,
          data.state||null,data.country||null,data.postal_code||null,data.photo||null,data.phone_verified||0,
          data.created_at||null);
    } else if (row.record_type === 'access_request') {
      db.prepare(`INSERT OR IGNORE INTO exam_access_requests(id,exam_id,name,email,phone,message,status,
        reviewed_by,reviewed_at,reject_reason,link_token,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(data.id,data.exam_id,data.name||null,data.email,data.phone||null,data.message||null,
          data.status||'pending',data.reviewed_by||null,data.reviewed_at||null,data.reject_reason||null,
          data.link_token||null,data.created_at||null);
    } else if (row.record_type === 'admin_user') {
      db.prepare(`INSERT OR IGNORE INTO users(id,username,email,password_hash,full_name,role,is_active,created_at)
        VALUES(?,?,?,?,?,?,1,?)`)
        .run(data.id,data.username,data.email,data.password_hash||'',data.full_name||data.username,
          data.role||'exam_manager',data.created_at||null);
    } else {
      return res.status(400).json({ error: `Restore not supported for type: ${row.record_type}` });
    }
    db.prepare('DELETE FROM deleted_records WHERE id=?').run(row.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/recycle/:id — permanently delete one record
router.delete('/:id', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM deleted_records WHERE id=?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  let data = {};
  try { data = JSON.parse(row.record_data); } catch {}
  db.prepare(`INSERT INTO deletion_log(record_type,record_id,summary,deleted_by_id,deleted_by_name,
    originally_deleted_at,purged_by_id,purged_by_name,purge_reason)
    VALUES(?,?,?,?,?,?,?,?,'manual')`)
    .run(row.record_type, row.record_id, makeSummary(row.record_type, data),
      row.deleted_by, row.deleted_by_name, row.deleted_at,
      req.user.id, req.user.full_name || req.user.username);
  db.prepare('DELETE FROM deleted_records WHERE id=?').run(row.id);
  res.json({ ok: true });
});

// DELETE /api/recycle — purge all expired (scheduled_purge_at <= now) records
router.delete('/', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const { purge_all } = req.query;
  let rows;
  if (purge_all === '1') {
    rows = db.prepare('SELECT * FROM deleted_records').all();
  } else {
    rows = db.prepare("SELECT * FROM deleted_records WHERE scheduled_purge_at IS NOT NULL AND datetime(scheduled_purge_at) <= datetime('now')").all();
  }
  let purged = 0;
  const ins = db.prepare(`INSERT INTO deletion_log(record_type,record_id,summary,deleted_by_id,deleted_by_name,
    originally_deleted_at,purged_by_id,purged_by_name,purge_reason) VALUES(?,?,?,?,?,?,?,?,?)`);
  const del = db.prepare('DELETE FROM deleted_records WHERE id=?');
  db.transaction(() => {
    for (const row of rows) {
      let data = {};
      try { data = JSON.parse(row.record_data); } catch {}
      const reason = purge_all === '1' ? 'admin_purge_all' : 'auto_schedule';
      ins.run(row.record_type, row.record_id, makeSummary(row.record_type, data),
        row.deleted_by, row.deleted_by_name, row.deleted_at,
        req.user.id, req.user.full_name || req.user.username, reason);
      del.run(row.id);
      purged++;
    }
  })();
  res.json({ ok: true, purged });
});

// GET /api/recycle/settings
router.get('/settings', auth, requireRole('exam_manager', 'super_admin'), (req, res) => {
  const db = getDb();
  const days = parseInt(db.prepare("SELECT value FROM settings WHERE key='recycle_bin_days'").get()?.value || '30');
  res.json({ recycle_bin_days: days });
});

// PUT /api/recycle/settings — update recycle_bin_days
router.put('/settings', auth, requireRole('super_admin'), (req, res) => {
  const db = getDb();
  const { days } = req.body;
  const val = parseInt(days);
  if (isNaN(val) || val < 0) return res.status(400).json({ error: 'Invalid days value' });
  db.prepare("INSERT OR REPLACE INTO settings(key, value, description) VALUES('recycle_bin_days',?,'Days before auto-permanent-delete of recycle bin items (0 = never)')").run(String(val));
  res.json({ ok: true });
});

module.exports = router;
