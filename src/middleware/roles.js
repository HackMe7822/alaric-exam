const ROLE_HIERARCHY = {
  super_admin: 4,
  exam_manager: 3,
  checker: 2,
  viewer: 1
};

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (roles.includes(req.user.role)) return next();
    // Also allow higher roles
    const userLevel = ROLE_HIERARCHY[req.user.role] || 0;
    const minLevel = Math.min(...roles.map(r => ROLE_HIERARCHY[r] || 0));
    if (userLevel >= minLevel) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Super admin only' });
  next();
}

module.exports = { requireRole, requireSuperAdmin, ROLE_HIERARCHY };
