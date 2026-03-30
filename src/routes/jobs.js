const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware');
const jobDb = require('../jobs/database');
const runner = require('../jobs/runner');

// All routes require auth
router.use(authenticateToken);

// ── Profile ──────────────────────────────────────────────────────────────────

router.get('/profile', (req, res) => {
  const profile = jobDb.getProfile(req.user.id);
  if (!profile) return res.json({ profile: null });
  // Parse JSON fields
  try { profile.skills = JSON.parse(profile.skills || '[]'); } catch { profile.skills = []; }
  try { profile.experience = JSON.parse(profile.experience || '[]'); } catch { profile.experience = []; }
  try { profile.education = JSON.parse(profile.education || '[]'); } catch { profile.education = []; }
  // Don't send resume blob
  delete profile.resume_data;
  res.json({ profile });
});

router.put('/profile', (req, res) => {
  const { full_name, phone, email, location, headline, summary, skills, experience, education } = req.body;
  jobDb.upsertProfile(req.user.id, { full_name, phone, email, location, headline, summary, skills, experience, education });
  res.json({ ok: true });
});

// ── Resume ───────────────────────────────────────────────────────────────────

router.post('/resume', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  const filename = req.headers['x-filename'] || 'resume.pdf';
  const mime = req.headers['content-type'] || 'application/pdf';
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Keine Datei' });
  jobDb.saveResume(req.user.id, req.body, filename, mime);
  res.json({ ok: true, filename });
});

router.get('/resume', (req, res) => {
  const profile = jobDb.getProfile(req.user.id);
  if (!profile || !profile.resume_data) return res.status(404).json({ error: 'Kein Lebenslauf' });
  res.set('Content-Type', profile.resume_mime || 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${profile.resume_filename || 'resume.pdf'}"`);
  res.send(profile.resume_data);
});

router.get('/resume/info', (req, res) => {
  const profile = jobDb.getProfile(req.user.id);
  if (!profile || !profile.resume_data) return res.json({ hasResume: false });
  res.json({ hasResume: true, filename: profile.resume_filename, mime: profile.resume_mime });
});

// ── Preferences ──────────────────────────────────────────────────────────────

router.get('/preferences', (req, res) => {
  const prefs = jobDb.getPreferences(req.user.id);
  if (!prefs) return res.json({ preferences: null });
  try { prefs.keywords = JSON.parse(prefs.keywords || '[]'); } catch { prefs.keywords = []; }
  try { prefs.exclude_keywords = JSON.parse(prefs.exclude_keywords || '[]'); } catch { prefs.exclude_keywords = []; }
  prefs.auto_apply = !!prefs.auto_apply;
  res.json({ preferences: prefs });
});

router.put('/preferences', (req, res) => {
  const { keywords, location, radius_km, job_type, salary_min, salary_max,
          remote_preference, exclude_keywords, max_applications_per_run, auto_apply } = req.body;
  jobDb.upsertPreferences(req.user.id, {
    keywords, location, radius_km, job_type, salary_min, salary_max,
    remote_preference, exclude_keywords, max_applications_per_run, auto_apply
  });
  res.json({ ok: true });
});

// ── Applications ─────────────────────────────────────────────────────────────

router.get('/applications', (req, res) => {
  const { status, limit, offset } = req.query;
  const apps = jobDb.getApplications(req.user.id, {
    status: status || undefined,
    limit: parseInt(limit) || 50,
    offset: parseInt(offset) || 0
  });
  res.json({ applications: apps });
});

router.patch('/applications/:id/status', (req, res) => {
  const { status, notes } = req.body;
  const validStatuses = ['found', 'applied', 'viewed', 'interview', 'rejected', 'offer', 'withdrawn'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Ungültiger Status' });
  jobDb.updateApplicationStatus(req.params.id, req.user.id, status, notes);
  res.json({ ok: true });
});

// ── Stats ────────────────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  const stats = jobDb.getStats(req.user.id);
  res.json(stats);
});

// ── Search / Automation ──────────────────────────────────────────────────────

router.post('/search/start', async (req, res) => {
  const result = await runner.startRun(req.user.id, req.app.get('jobIo'));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.post('/search/stop', async (req, res) => {
  const result = await runner.stopRun(req.user.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.get('/search/status', (req, res) => {
  res.json(runner.getStatus(req.user.id));
});

// ── Logs ─────────────────────────────────────────────────────────────────────

router.get('/logs', (req, res) => {
  const { run_id, limit } = req.query;
  const logs = jobDb.getLogs(req.user.id, {
    runId: run_id || undefined,
    limit: parseInt(limit) || 100
  });
  res.json({ logs });
});

module.exports = router;
