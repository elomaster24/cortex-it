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
      force_password_change INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      user_id TEXT,
      action TEXT NOT NULL,
      target TEXT,
      ip TEXT,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS token_blacklist (
      jti TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
  `);

  // Migrate existing DBs: add new columns if they don't exist
  const cols = db.pragma('table_info(users)').map(c => c.name);
  if (!cols.includes('force_password_change')) {
    db.exec('ALTER TABLE users ADD COLUMN force_password_change INTEGER DEFAULT 0');
  }

  // Clean up expired blacklisted tokens periodically
  db.prepare("DELETE FROM token_blacklist WHERE expires_at < datetime('now')").run();

  // Create default admin if not exists
  const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 12);
    db.prepare(`
      INSERT INTO users (id, email, name, company, role, password_hash, force_password_change)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(uuidv4(), 'admin@cortex.local', 'Admin', 'CORTEX', 'admin', hash);
    console.log('\x1b[33m[CORTEX]\x1b[0m Standard-Admin erstellt: admin@cortex.local / admin123 — Passwort beim ersten Login ändern!');
  }

  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

function auditLog(userId, action, target, ip, detail) {
  try {
    getDb().prepare('INSERT INTO audit_log (user_id, action, target, ip, detail) VALUES (?, ?, ?, ?, ?)')
      .run(userId || null, action, target || null, ip || null, detail ? JSON.stringify(detail) : null);
  } catch {}
}

module.exports = { init, getDb, auditLog };
