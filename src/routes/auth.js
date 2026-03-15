const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { JWT_SECRET, authenticateToken } = require('../middleware');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!user.is_active) return res.status(403).json({ error: 'Account deactivated' });

  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  db.prepare('UPDATE users SET last_active = datetime("now") WHERE id = ?').run(user.id);

  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, company: user.company, role: user.role }
  });
});

router.post('/register', (req, res) => {
  const { email, password, name, company } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, password, and name required' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, email, name, company, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(id, email, name, company || '', hash);

  const token = jwt.sign({ userId: id, role: 'user' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id, email, name, company: company || '', role: 'user' } });
});

router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
