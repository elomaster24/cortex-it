const jwt = require('jsonwebtoken');
const { getDb } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'cortex-secret-key-change-me';

function getTokenFromRequest(req) {
  // Try httpOnly session cookie first
  const cookieHeader = req.headers.cookie || '';
  const sessionMatch = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  if (sessionMatch) {
    try { return decodeURIComponent(sessionMatch[1]); } catch {}
  }
  // Fallback: Authorization header (for desktop agent and API clients)
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

function authenticateToken(req, res, next) {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Token required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.jti) {
      const blacklisted = getDb().prepare('SELECT jti FROM token_blacklist WHERE jti = ?').get(decoded.jti);
      if (blacklisted) return res.status(401).json({ error: 'Token revoked' });
    }

    const db = getDb();
    const user = db.prepare('SELECT id, email, name, company, role, is_active, force_password_change FROM users WHERE id = ?').get(decoded.userId);
    if (!user || !user.is_active) return res.status(403).json({ error: 'Access denied' });
    req.user = user;
    req.tokenJti = decoded.jti || null;
    req.tokenExp = decoded.exp || null;
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

module.exports = { authenticateToken, requireAdmin, JWT_SECRET, getTokenFromRequest };
