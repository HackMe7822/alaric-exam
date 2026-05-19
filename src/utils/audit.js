const { getDb } = require('../../database/index');

function audit(userId, action, resourceType, resourceId, details, req) {
  try {
    const db = getDb();
    db.prepare(`INSERT INTO audit_log(user_id, action, resource_type, resource_id, details, ip_address, user_agent)
      VALUES(?,?,?,?,?,?,?)`)
      .run(
        userId || null,
        action,
        resourceType || null,
        resourceId || null,
        details ? JSON.stringify(details) : null,
        req?.ip || null,
        req?.headers?.['user-agent'] || null
      );
  } catch (e) {
    // audit failures must never crash the app
    console.error('Audit log error:', e.message);
  }
}

module.exports = { audit };
