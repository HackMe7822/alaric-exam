const { getDb } = require('../../database/index');

function softDelete(db, userId, userName, recordType, recordId, recordData) {
  const days = parseInt(db.prepare("SELECT value FROM settings WHERE key='recycle_bin_days'").get()?.value || '0');
  let scheduledPurgeAt = null;
  if (days > 0) {
    scheduledPurgeAt = db.prepare("SELECT datetime('now', ?) as t").get(`+${days} days`).t;
  }
  db.prepare(`INSERT INTO deleted_records(record_type, record_id, record_data, deleted_by, deleted_by_name, scheduled_purge_at)
    VALUES(?,?,?,?,?,?)`)
    .run(recordType, recordId, JSON.stringify(recordData), userId || null, userName || null, scheduledPurgeAt);
}

function makeSummary(recordType, data) {
  try {
    if (recordType === 'candidate') return `Candidate: ${data.name || ''} (${data.email || ''})`;
    if (recordType === 'access_request') return `Access Request: ${data.name || data.email || ''} → ${data.exam_title || `Exam #${data.exam_id}`}`;
    if (recordType === 'admin_user') return `Admin User: ${data.username || ''} (${data.email || ''})`;
    if (recordType === 'exam') return `Exam: ${data.title || ''} [${data.code || ''}]`;
    return `${recordType} #${data.id || '?'}`;
  } catch { return recordType; }
}

module.exports = { softDelete, makeSummary };
