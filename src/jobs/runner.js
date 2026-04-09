const JobAutomation = require('./automation');
const LinkedInAutomation = require('./linkedin');
const jobDb = require('./database');

const activeRuns = new Map(); // userId -> { automations, runId, status }

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

  const platforms = JSON.parse(preferences.platforms || '["indeed"]');
  if (!platforms.length) return { error: 'Keine Plattform ausgewählt' };

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

  const automations = [];
  activeRuns.set(userId, { automations, runId, status: 'running' });
  emitToUser('job_status', { status: 'running', runId, platforms });

  // Run async
  (async () => {
    let totalFound = 0;
    let totalApplied = 0;
    const allJobs = [];

    try {
      // Run each platform sequentially
      for (const platform of platforms) {
        if (activeRuns.get(userId)?.status === 'stopped') break;

        let automation;
        if (platform === 'indeed') {
          automation = new JobAutomation(userId, preferences, profile, callbacks);
        } else if (platform === 'linkedin') {
          automation = new LinkedInAutomation(userId, preferences, profile, callbacks);
        } else {
          callbacks.onLog('warn', `Unbekannte Plattform: ${platform}`);
          continue;
        }

        automations.push(automation);
        callbacks.onLog('info', `━━━ Starte ${platform.toUpperCase()} ━━━`);

        try {
          await automation.launch();
          const jobs = await automation.searchJobs();

          // Tag jobs with platform
          for (const job of jobs) {
            job.platform = job.platform || platform;
          }

          allJobs.push(...jobs);
          totalFound += jobs.length;
          jobDb.updateRun(runId, { jobs_found: totalFound });

          const maxApply = preferences.max_applications_per_run || 20;

          for (const job of jobs) {
            if (automation.stopped || totalApplied >= maxApply) break;

            // Check if already applied (by job ID, URL, or title+company match)
            const allApps = jobDb.getApplications(userId, {});
            const existing = allApps.find(
              a => (a.indeed_job_id === job.indeed_job_id && job.indeed_job_id) ||
                   (a.job_url === job.job_url && job.job_url) ||
                   (a.job_title === job.job_title && a.company === job.company && job.job_title)
            );
            if (existing) {
              callbacks.onLog('info', `Bereits beworben: ${job.job_title} @ ${job.company}`);
              continue;
            }

            const success = await automation.applyToJob(job);
            jobDb.addApplication(userId, {
              ...job,
              status: success ? 'applied' : 'found'
            });

            if (success) totalApplied++;

            jobDb.updateRun(runId, { jobs_applied: totalApplied });
            emitToUser('job_stats_update', { jobs_found: totalFound, jobs_applied: totalApplied });

            // Random delay between applications
            if (!automation.stopped) {
              const delay = 5000 + Math.random() * 10000;
              callbacks.onLog('info', `Warte ${Math.round(delay / 1000)}s vor nächster Bewerbung...`);
              await new Promise(r => setTimeout(r, delay));
            }
          }

          // Close this platform's browser
          await automation.stop();
        } catch (err) {
          callbacks.onLog('error', `[${platform}] Fehler: ${err.message}`);
          try { await automation.stop(); } catch {}
        }
      }

      jobDb.updateRun(runId, {
        status: 'completed',
        jobs_found: totalFound,
        jobs_applied: totalApplied,
        ended_at: new Date().toISOString()
      });

      callbacks.onLog('info', `━━━ Alle Plattformen abgeschlossen: ${totalFound} gefunden, ${totalApplied} beworben ━━━`);
      emitToUser('job_status', { status: 'completed', runId, jobs_found: totalFound, jobs_applied: totalApplied });

    } catch (err) {
      jobDb.updateRun(runId, {
        status: 'failed',
        error_message: err.message,
        ended_at: new Date().toISOString()
      });
      callbacks.onLog('error', `Fehler: ${err.message}`);
      emitToUser('job_status', { status: 'failed', error: err.message });
    } finally {
      // Ensure all browsers are closed
      for (const a of automations) {
        try { await a.stop(); } catch {}
      }
      activeRuns.delete(userId);
    }
  })();

  return { runId, status: 'running', platforms };
}

async function stopRun(userId) {
  const entry = activeRuns.get(userId);
  if (!entry) return { error: 'Keine aktive Suche' };

  entry.status = 'stopped';
  for (const a of entry.automations) {
    try { await a.stop(); } catch {}
  }
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
  let jobsFound = 0, jobsApplied = 0;
  for (const a of entry.automations) {
    jobsFound += a.jobsFound || 0;
    jobsApplied += a.jobsApplied || 0;
  }
  return { running: true, runId: entry.runId, jobsFound, jobsApplied };
}

module.exports = { startRun, stopRun, getStatus };
