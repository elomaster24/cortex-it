const { getDb } = require('../database');
const { v4: uuidv4 } = require('uuid');

function initJobTables() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS job_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      full_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      location TEXT DEFAULT '',
      headline TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      skills TEXT DEFAULT '[]',
      experience TEXT DEFAULT '[]',
      education TEXT DEFAULT '[]',
      resume_data BLOB,
      resume_filename TEXT,
      resume_mime TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS job_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      keywords TEXT DEFAULT '[]',
      location TEXT DEFAULT '',
      radius_km INTEGER DEFAULT 50,
      job_type TEXT DEFAULT 'fulltime',
      salary_min INTEGER DEFAULT 0,
      salary_max INTEGER DEFAULT 0,
      remote_preference TEXT DEFAULT 'any',
      exclude_keywords TEXT DEFAULT '[]',
      max_applications_per_run INTEGER DEFAULT 20,
      auto_apply INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS job_applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_title TEXT DEFAULT '',
      company TEXT DEFAULT '',
      location TEXT DEFAULT '',
      salary_info TEXT DEFAULT '',
      job_url TEXT DEFAULT '',
      indeed_job_id TEXT DEFAULT '',
      status TEXT DEFAULT 'applied',
      applied_at TEXT DEFAULT (datetime('now')),
      notes TEXT DEFAULT '',
      job_description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS job_search_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      jobs_found INTEGER DEFAULT 0,
      jobs_applied INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS job_automation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      run_id TEXT,
      level TEXT DEFAULT 'info',
      message TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_job_applications_user ON job_applications(user_id);
    CREATE INDEX IF NOT EXISTS idx_job_applications_status ON job_applications(status);
    CREATE INDEX IF NOT EXISTS idx_job_search_runs_user ON job_search_runs(user_id);
    CREATE INDEX IF NOT EXISTS idx_job_automation_logs_run ON job_automation_logs(run_id);
  `);
}

// ── Helper functions ──────────────────────────────────────────────────────────

function getProfile(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM job_profiles WHERE user_id = ?').get(userId) || null;
}

function upsertProfile(userId, data) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM job_profiles WHERE user_id = ?').get(userId);
  if (existing) {
    db.prepare(`
      UPDATE job_profiles SET full_name=?, phone=?, email=?, location=?, headline=?, summary=?,
        skills=?, experience=?, education=?, updated_at=datetime('now')
      WHERE user_id=?
    `).run(data.full_name, data.phone, data.email, data.location, data.headline, data.summary,
      JSON.stringify(data.skills || []), JSON.stringify(data.experience || []),
      JSON.stringify(data.education || []), userId);
    return existing.id;
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO job_profiles (id, user_id, full_name, phone, email, location, headline, summary, skills, experience, education)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, data.full_name || '', data.phone || '', data.email || '', data.location || '',
    data.headline || '', data.summary || '', JSON.stringify(data.skills || []),
    JSON.stringify(data.experience || []), JSON.stringify(data.education || []));
  return id;
}

function saveResume(userId, buffer, filename, mime) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM job_profiles WHERE user_id = ?').get(userId);
  if (existing) {
    db.prepare(`UPDATE job_profiles SET resume_data=?, resume_filename=?, resume_mime=?, updated_at=datetime('now') WHERE user_id=?`)
      .run(buffer, filename, mime, userId);
  } else {
    db.prepare(`INSERT INTO job_profiles (id, user_id, resume_data, resume_filename, resume_mime) VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), userId, buffer, filename, mime);
  }
}

function getPreferences(userId) {
  return getDb().prepare('SELECT * FROM job_preferences WHERE user_id = ?').get(userId) || null;
}

function upsertPreferences(userId, data) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM job_preferences WHERE user_id = ?').get(userId);
  if (existing) {
    db.prepare(`
      UPDATE job_preferences SET keywords=?, location=?, radius_km=?, job_type=?, salary_min=?, salary_max=?,
        remote_preference=?, exclude_keywords=?, max_applications_per_run=?, auto_apply=?, updated_at=datetime('now')
      WHERE user_id=?
    `).run(JSON.stringify(data.keywords || []), data.location || '', data.radius_km || 50,
      data.job_type || 'fulltime', data.salary_min || 0, data.salary_max || 0,
      data.remote_preference || 'any', JSON.stringify(data.exclude_keywords || []),
      data.max_applications_per_run || 20, data.auto_apply ? 1 : 0, userId);
    return existing.id;
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO job_preferences (id, user_id, keywords, location, radius_km, job_type, salary_min, salary_max,
      remote_preference, exclude_keywords, max_applications_per_run, auto_apply)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, JSON.stringify(data.keywords || []), data.location || '', data.radius_km || 50,
    data.job_type || 'fulltime', data.salary_min || 0, data.salary_max || 0,
    data.remote_preference || 'any', JSON.stringify(data.exclude_keywords || []),
    data.max_applications_per_run || 20, data.auto_apply ? 1 : 0);
  return id;
}

function addApplication(userId, data) {
  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO job_applications (id, user_id, job_title, company, location, salary_info, job_url, indeed_job_id, status, job_description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, data.job_title || '', data.company || '', data.location || '',
    data.salary_info || '', data.job_url || '', data.indeed_job_id || '',
    data.status || 'applied', data.job_description || '');
  return id;
}

function getApplications(userId, { status, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM job_applications WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(userId, status, limit, offset);
  }
  return db.prepare('SELECT * FROM job_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(userId, limit, offset);
}

function updateApplicationStatus(id, userId, status, notes) {
  getDb().prepare('UPDATE job_applications SET status = ?, notes = COALESCE(?, notes) WHERE id = ? AND user_id = ?')
    .run(status, notes || null, id, userId);
}

function getStats(userId) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM job_applications WHERE user_id = ?').get(userId).c;
  const thisWeek = db.prepare("SELECT COUNT(*) as c FROM job_applications WHERE user_id = ? AND created_at >= datetime('now', '-7 days')").get(userId).c;
  const byStatus = db.prepare('SELECT status, COUNT(*) as c FROM job_applications WHERE user_id = ? GROUP BY status').all(userId);
  const recentRun = db.prepare('SELECT * FROM job_search_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 1').get(userId);
  return { total, thisWeek, byStatus, recentRun };
}

function createRun(userId) {
  const id = uuidv4();
  getDb().prepare('INSERT INTO job_search_runs (id, user_id) VALUES (?, ?)').run(id, userId);
  return id;
}

function updateRun(id, data) {
  const db = getDb();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE job_search_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function addLog(userId, runId, level, message, detail) {
  getDb().prepare('INSERT INTO job_automation_logs (user_id, run_id, level, message, detail) VALUES (?, ?, ?, ?, ?)')
    .run(userId, runId, level, message, detail ? JSON.stringify(detail) : null);
}

function getLogs(userId, { runId, limit = 100 } = {}) {
  const db = getDb();
  if (runId) {
    return db.prepare('SELECT * FROM job_automation_logs WHERE user_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, runId, limit);
  }
  return db.prepare('SELECT * FROM job_automation_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit);
}

module.exports = {
  initJobTables, getProfile, upsertProfile, saveResume,
  getPreferences, upsertPreferences,
  addApplication, getApplications, updateApplicationStatus,
  getStats, createRun, updateRun, addLog, getLogs
};
