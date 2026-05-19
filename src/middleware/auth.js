const jwt = require('jsonwebtoken');
const { getDb } = require('../../database/index');

function authMiddleware(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE jti=? AND revoked=0').get(payload.jti);
  if (!session) return res.status(401).json({ error: 'Session revoked' });

  const user = db.prepare('SELECT * FROM users WHERE id=? AND is_active=1').get(payload.sub);
  if (!user) return res.status(401).json({ error: 'User not found or inactive' });

  req.user = user;
  req.token = token;
  next();
}

module.exports = authMiddleware;
