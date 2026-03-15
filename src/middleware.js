const jwt = require('jsonwebtoken');
const { getDb } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'cortex-secret-key-change-me';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = db.prepare('SELECT id, email, name, company, role, is_active FROM users WHERE id = ?').get(decoded.userId);
    if (!user || !user.is_active) return res.status(403).json({ error: 'Access denied' });
    req.user = user;
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { authenticateToken, requireAdmin, JWT_SECRET };
