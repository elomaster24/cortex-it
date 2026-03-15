const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '..', 'cortex.db');

let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      company TEXT DEFAULT '',
      role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      password_hash TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_active TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      model_used TEXT DEFAULT 'sonnet',
      total_tokens INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      model TEXT DEFAULT 'sonnet',
      tokens_used INTEGER DEFAULT 0,
      risk_level TEXT DEFAULT 'low' CHECK(risk_level IN ('none', 'low', 'medium', 'high', 'critical')),
      changes_made TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      haiku_tokens INTEGER DEFAULT 0,
      sonnet_tokens INTEGER DEFAULT 0,
      opus_tokens INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, month)
    );
  `);

  // Create default admin if not exists
  const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO users (id, email, name, company, role, password_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), 'admin@cortex.local', 'Admin', 'CORTEX', 'admin', hash);
  }

  // Create demo user if not exists
  const userExists = db.prepare('SELECT id FROM users WHERE role = ?').get('user');
  if (!userExists) {
    const hash = bcrypt.hashSync('user123', 10);
    db.prepare(`
      INSERT INTO users (id, email, name, company, role, password_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), 'demo@company.com', 'Demo User', 'Demo GmbH', 'user', hash);
  }

  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

module.exports = { init, getDb };
