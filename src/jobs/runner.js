const JobAutomation = require('./automation');
const jobDb = require('./database');

const activeRuns = new Map(); // userId -> { automation, runId, status }

async function startRun(userId, io) {
  if (activeRuns.has(userId)) {
    return { error: 'Es läuft bereits eine Suche' };
  }

  const profile = jobDb.getProfile(userId);
  if (!profile) return { error: 'Bitte zuerst Profil ausfüllen' };

  const preferences = jobDb.getPreferences(userId);
  if (!preferences) return { error: 'Bitte zuerst Sucheinstellungen konfigurieren' };

  const keywords = JSON.parse(preferences.keywords || '[]');
  if (!keywords.length) return { error: 'Keine Suchbegriffe konfiguriert' };

  const runId = jobDb.createRun(userId);

  const emitToUser = (event, data) => {
    if (io) io.to(`job_${userId}`).emit(event, data);
  };

  const callbacks = {
    onLog: (level, message, detail) => {
      jobDb.addLog(userId, runId, level, message, detail);
      emitToUser('job_log', { level, message, detail, timestamp: new Date().toISOString() });
    },
    onProgress: (data) => {
      emitToUser('job_progress', data);
    },
    onJobFound: (job) => {
      emitToUser('job_found', job);
    },
    onApplied: (job) => {
      emitToUser('job_applied', job);
    }
  };

  const automation = new JobAutomation(userId, preferences, profile, callbacks);

  activeRuns.set(userId, { automation, runId, status: 'running' });
  emitToUser('job_status', { status: 'running', runId });

  // Run async
  (async () => {
    try {
      await automation.launch();

      const jobs = await automation.searchJobs();
      jobDb.updateRun(runId, { jobs_found: jobs.length });

      const maxApply = preferences.max_applications_per_run || 20;
      let applied = 0;

      for (const job of jobs) {
        if (automation.stopped || applied >= maxApply) break;

        // Check if already applied
        const existing = jobDb.getApplications(userId, {}).find(
          a => a.indeed_job_id === job.indeed_job_id && job.indeed_job_id
        );
        if (existing) {
          callbacks.onLog('info', `Bereits beworben: ${job.job_title} @ ${job.company}`);
          continue;
        }

        const success = await automation.applyToJob(job);
        const appId = jobDb.addApplication(userId, {
          ...job,
          status: success ? 'applied' : 'found'
        });

        if (success) applied++;

        jobDb.updateRun(runId, { jobs_applied: applied });
        emitToUser('job_stats_update', { jobs_found: jobs.length, jobs_applied: applied });

        // Random delay between applications
        if (!automation.stopped) {
          const delay = 5000 + Math.random() * 10000;
          callbacks.onLog('info', `Warte ${Math.round(delay / 1000)}s vor nächster Bewerbung...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }

      jobDb.updateRun(runId, {
        status: 'completed',
        jobs_found: jobs.length,
        jobs_applied: applied,
        ended_at: new Date().toISOString()
      });

      callbacks.onLog('info', `Suche abgeschlossen: ${jobs.length} gefunden, ${applied} beworben`);
      emitToUser('job_status', { status: 'completed', runId, jobs_found: jobs.length, jobs_applied: applied });

    } catch (err) {
      jobDb.updateRun(runId, {
        status: 'failed',
        error_message: err.message,
        ended_at: new Date().toISOString()
      });
      callbacks.onLog('error', `Fehler: ${err.message}`);
      emitToUser('job_status', { status: 'failed', error: err.message });
    } finally {
      try { await automation.stop(); } catch {}
      activeRuns.delete(userId);
    }
  })();

  return { runId, status: 'running' };
}

async function stopRun(userId) {
  const entry = activeRuns.get(userId);
  if (!entry) return { error: 'Keine aktive Suche' };

  await entry.automation.stop();
  jobDb.updateRun(entry.runId, {
    status: 'stopped',
    ended_at: new Date().toISOString()
  });
  activeRuns.delete(userId);
  return { status: 'stopped' };
}

function getStatus(userId) {
  const entry = activeRuns.get(userId);
  if (!entry) return { running: false };
  return {
    running: true,
    runId: entry.runId,
    jobsFound: entry.automation.jobsFound,
    jobsApplied: entry.automation.jobsApplied
  };
}

module.exports = { startRun, stopRun, getStatus };
