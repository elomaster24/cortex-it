const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb, auditLog } = require('../database');
const { authenticateToken, requireAdmin } = require('../middleware');

const router = express.Router();
router.use(authenticateToken, requireAdmin);

function getIp(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// Dashboard stats
router.get('/stats', (req, res) => {
  const db = getDb();
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('user');
  const activeUsers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'user' AND last_active >= datetime('now', '-7 days')`).get();
  const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get();
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get();

  const tokenStats = db.prepare(`
    SELECT
      COALESCE(SUM(haiku_tokens), 0) as haiku,
      COALESCE(SUM(sonnet_tokens), 0) as sonnet,
      COALESCE(SUM(opus_tokens), 0) as opus
    FROM token_usage
  `).get();

  const recentActivity = db.prepare(`
    SELECT m.created_at, m.content, m.model, m.risk_level, m.role, u.name, u.company
    FROM messages m JOIN users u ON m.user_id = u.id
    ORDER BY m.created_at DESC LIMIT 20
  `).all();

  const riskDistribution = db.prepare(`
    SELECT risk_level, COUNT(*) as count FROM messages WHERE role = 'assistant' GROUP BY risk_level
  `).all();

  res.json({
    totalUsers: totalUsers.count,
    activeUsers: activeUsers.count,
    totalSessions: totalSessions.count,
    totalMessages: totalMessages.count,
    tokenStats,
    recentActivity,
    riskDistribution
  });
});

// Audit log
router.get('/audit-log', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const logs = db.prepare(`
    SELECT a.*, u.email, u.name
    FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.ts DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  res.json(logs);
});

// List all users
router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.company, u.role, u.is_active, u.force_password_change, u.created_at, u.last_active,
      (SELECT COUNT(*) FROM sessions WHERE user_id = u.id) as session_count,
      (SELECT COUNT(*) FROM messages WHERE user_id = u.id AND role = 'user') as message_count,
      (SELECT COALESCE(SUM(haiku_tokens), 0) FROM token_usage WHERE user_id = u.id) as haiku_tokens,
      (SELECT COALESCE(SUM(sonnet_tokens), 0) FROM token_usage WHERE user_id = u.id) as sonnet_tokens,
      (SELECT COALESCE(SUM(opus_tokens), 0) FROM token_usage WHERE user_id = u.id) as opus_tokens
    FROM users u ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// Get user detail
router.get('/users/:id', (req, res) => {
  const db = getDb();
  const user = db.prepare(`
    SELECT id, email, name, company, role, is_active, force_password_change, created_at, last_active FROM users WHERE id = ?
  `).get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const sessions = db.prepare(`
    SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 50
  `).all(req.params.id);

  const messages = db.prepare(`
    SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(req.params.id);

  const tokenUsage = db.prepare(`
    SELECT * FROM token_usage WHERE user_id = ? ORDER BY month DESC
  `).all(req.params.id);

  res.json({ user, sessions, messages, tokenUsage });
});

// Toggle user active status
router.patch('/users/:id/toggle', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, is_active FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newState = user.is_active ? 0 : 1;
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newState, user.id);
  auditLog(req.user.id, newState ? 'user_activated' : 'user_deactivated', user.email, getIp(req));
  res.json({ success: true, is_active: !!newState });
});

// Create user
router.post('/users', (req, res) => {
  const { email, password, name, company, role } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 6) return res.status(400).json({ error: 'Passwort zu kurz (min. 6 Zeichen)' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email exists' });

  const hash = bcrypt.hashSync(password, 12);
  const id = uuidv4();
  const safeRole = role === 'admin' ? 'admin' : 'user';
  db.prepare('INSERT INTO users (id, email, name, company, role, password_hash, force_password_change) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(id, email, name, company || '', safeRole, hash);

  auditLog(req.user.id, 'user_created', email, getIp(req), { role: safeRole });
  res.json({ success: true, id });
});

// Delete user
router.delete('/users/:id', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM messages WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM token_usage WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);

  auditLog(req.user.id, 'user_deleted', user.email, getIp(req));
  res.json({ success: true });
});

module.exports = router;
