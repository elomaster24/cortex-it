const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb, auditLog } = require('../database');
const { JWT_SECRET, authenticateToken } = require('../middleware');

const router = express.Router();

const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.HTTPS === 'true',
  sameSite: 'strict',
  maxAge: 24 * 60 * 60 * 1000,
  path: '/'
};

// In-memory rate limiter (backs up DB lockout)
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= 20;
}

function getIp(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function signSessionToken(userId, role) {
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign({ userId, role, jti }, JWT_SECRET, { expiresIn: '24h' });
  return { token, jti };
}

router.post('/login', (req, res) => {
  const ip = getIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warte.' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user) {
    auditLog(null, 'login_failed', email, ip, { reason: 'user_not_found' });
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }

  // Check account lockout
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    auditLog(user.id, 'login_failed', email, ip, { reason: 'account_locked' });
    return res.status(429).json({ error: `Konto gesperrt nach zu vielen Fehlversuchen. Noch ${mins} Minute(n).` });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    const newAttempts = (user.login_attempts || 0) + 1;
    const shouldLock = newAttempts >= 5;
    const lockUntil = shouldLock
      ? new Date(Date.now() + 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      : (user.locked_until || null);
    db.prepare('UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?').run(newAttempts, lockUntil, user.id);
    auditLog(user.id, 'login_failed', email, ip, { reason: 'wrong_password', attempts: newAttempts });
    if (shouldLock) return res.status(429).json({ error: 'Zu viele Fehlversuche. Konto für 15 Minuten gesperrt.' });
    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
  }

  if (!user.is_active) {
    auditLog(user.id, 'login_failed', email, ip, { reason: 'account_disabled' });
    return res.status(403).json({ error: 'Konto deaktiviert' });
  }

  // Successful login — reset lockout
  db.prepare("UPDATE users SET last_active = datetime('now'), login_attempts = 0, locked_until = NULL WHERE id = ?").run(user.id);
  auditLog(user.id, 'login', email, ip);

  const { token } = signSessionToken(user.id, user.role);
  res.cookie('session', token, SESSION_COOKIE_OPTS).json({
    user: { id: user.id, email: user.email, name: user.name, company: user.company, role: user.role },
    force_password_change: !!user.force_password_change
  });
});

router.post('/register', (req, res) => {
  const ip = getIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Zu viele Versuche. Bitte warte.' });

  const { email, password, name, company } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, Passwort und Name erforderlich' });
  if (password.length < 6) return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'E-Mail bereits registriert' });

  const hash = bcrypt.hashSync(password, 12);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, email, name, company, password_hash) VALUES (?, ?, ?, ?, ?)').run(id, email, name, company || '', hash);
  auditLog(id, 'register', email, ip);

  const { token } = signSessionToken(id, 'user');
  res.cookie('session', token, SESSION_COOKIE_OPTS).json({
    user: { id, email, name, company: company || '', role: 'user' },
    force_password_change: false
  });
});

router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Dedicated long-lived agent token (separate from session)
router.get('/agent-token', authenticateToken, (req, res) => {
  const jti = crypto.randomBytes(16).toString('hex');
  const agentToken = jwt.sign({ userId: req.user.id, role: req.user.role, jti, type: 'agent' }, JWT_SECRET, { expiresIn: '30d' });
  auditLog(req.user.id, 'agent_token_generated', null, getIp(req));
  res.json({ token: agentToken });
});

// Change password
router.post('/change-password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Felder erforderlich' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Neues Passwort zu kurz (min. 6 Zeichen)' });

  const db = getDb();
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    auditLog(req.user.id, 'change_password_failed', null, getIp(req), { reason: 'wrong_current_password' });
    return res.status(401).json({ error: 'Aktuelles Passwort falsch' });
  }

  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, force_password_change = 0 WHERE id = ?').run(hash, req.user.id);
  auditLog(req.user.id, 'change_password', null, getIp(req));
  res.json({ success: true });
});

// Logout — revoke token and clear cookie
router.post('/logout', authenticateToken, (req, res) => {
  if (req.tokenJti && req.tokenExp) {
    const expiresAt = new Date(req.tokenExp * 1000).toISOString().replace('T', ' ').slice(0, 19);
    try {
      getDb().prepare('INSERT OR IGNORE INTO token_blacklist (jti, expires_at) VALUES (?, ?)').run(req.tokenJti, expiresAt);
    } catch {}
  }
  auditLog(req.user.id, 'logout', null, getIp(req));
  res.clearCookie('session', { path: '/' }).json({ success: true });
});

module.exports = router;
