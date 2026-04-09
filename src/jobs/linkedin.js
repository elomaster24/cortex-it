const { chromium } = require('playwright');
const path = require('path');

const HEADLESS = process.env.JOB_BROWSER_HEADLESS !== 'false';
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'screenshots');

function randomDelay(min = 2000, max = 6000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

class LinkedInAutomation {
  constructor(userId, preferences, profile, callbacks = {}) {
    this.userId = userId;
    this.prefs = preferences;
    this.profile = profile;
    this.onLog = callbacks.onLog || (() => {});
    this.onProgress = callbacks.onProgress || (() => {});
    this.onJobFound = callbacks.onJobFound || (() => {});
    this.onApplied = callbacks.onApplied || (() => {});
    this.browser = null;
    this.page = null;
    this.stopped = false;
    this.jobsFound = 0;
    this.jobsApplied = 0;
    this.loggedIn = false;
  }

  async launch() {
    this.onLog('info', '[LinkedIn] Browser wird gestartet...');
    this.browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin'
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de', 'en-US', 'en'] });
    });

    this.page = await context.newPage();
    this.onLog('info', '[LinkedIn] Browser gestartet');
  }

  async login() {
    const email = process.env.LINKEDIN_EMAIL || this.profile.email;
    const password = process.env.LINKEDIN_PASSWORD;

    if (!email || !password) {
      this.onLog('error', '[LinkedIn] Login-Daten fehlen. Setze LINKEDIN_EMAIL und LINKEDIN_PASSWORD in .env');
      return false;
    }

    this.onLog('info', '[LinkedIn] Login wird durchgeführt...');

    try {
      await this.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomDelay(2000, 3000);

      // Fill login form
      await this.page.fill('#username', email);
      await randomDelay(500, 1000);
      await this.page.fill('#password', password);
      await randomDelay(500, 1000);

      await this.page.click('[data-litms-control-urn="login-submit"]');
      await randomDelay(3000, 5000);

      // Check if login was successful
      const currentUrl = this.page.url();
      if (currentUrl.includes('challenge') || currentUrl.includes('checkpoint')) {
        this.onLog('warn', '[LinkedIn] Sicherheitsüberprüfung erkannt — manuelles Eingreifen erforderlich');
        await this._screenshot('linkedin_challenge');
        return false;
      }

      if (currentUrl.includes('/feed') || currentUrl.includes('/mynetwork') || currentUrl.includes('/in/')) {
        this.onLog('info', '[LinkedIn] Login erfolgreich');
        this.loggedIn = true;
        return true;
      }

      // Check for error messages
      const errorEl = await this.page.$('[class*="alert-error"], [id*="error"], .form__label--error');
      if (errorEl) {
        const errorText = await errorEl.textContent().catch(() => 'Unbekannter Fehler');
        this.onLog('error', `[LinkedIn] Login fehlgeschlagen: ${errorText.trim()}`);
        return false;
      }

      this.onLog('warn', '[LinkedIn] Login-Status unklar, versuche fortzufahren...');
      this.loggedIn = true;
      return true;

    } catch (err) {
      this.onLog('error', `[LinkedIn] Login-Fehler: ${err.message}`);
      await this._screenshot('linkedin_login_error');
      return false;
    }
  }

  async searchJobs() {
    if (this.stopped) return [];

    const keywords = JSON.parse(this.prefs.keywords || '[]');
    const location = this.prefs.location || '';
    const query = keywords.join(' ');

    if (!query) {
      this.onLog('error', '[LinkedIn] Keine Suchbegriffe konfiguriert');
      return [];
    }

    // Login first if not logged in
    if (!this.loggedIn) {
      const loginOk = await this.login();
      if (!loginOk) return [];
    }

    this.onLog('info', `[LinkedIn] Suche: "${query}" in "${location || 'Überall'}"`);

    // Build LinkedIn Jobs URL
    const params = new URLSearchParams();
    params.set('keywords', query);
    if (location) params.set('location', location);

    // Easy Apply filter (f_AL=true)
    params.set('f_AL', 'true');

    // Job type mapping
    const jobTypeMap = {
      fulltime: 'F',
      parttime: 'P',
      contract: 'C',
      temporary: 'T',
      internship: 'I'
    };
    if (this.prefs.job_type && jobTypeMap[this.prefs.job_type]) {
      params.set('f_JT', jobTypeMap[this.prefs.job_type]);
    }

    // Remote filter
    const remoteMap = {
      remote: '2',
      hybrid: '3',
      onsite: '1'
    };
    if (this.prefs.remote_preference && remoteMap[this.prefs.remote_preference]) {
      params.set('f_WT', remoteMap[this.prefs.remote_preference]);
    }

    const url = `https://www.linkedin.com/jobs/search/?${params.toString()}`;
    this.onLog('info', `[LinkedIn] Öffne Suche: ${url}`);

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomDelay(3000, 5000);
    } catch (err) {
      this.onLog('error', `[LinkedIn] Seite konnte nicht geladen werden: ${err.message}`);
      await this._screenshot('linkedin_load_error');
      return [];
    }

    // Check if blocked
    const blocked = await this._checkBlocked();
    if (blocked) {
      this.onLog('warn', '[LinkedIn] Möglicherweise blockiert');
      await this._screenshot('linkedin_blocked');
      return [];
    }

    return await this.parseResults();
  }

  async parseResults() {
    const jobs = [];
    const excludeKeywords = JSON.parse(this.prefs.exclude_keywords || '[]').map(k => k.toLowerCase());

    try {
      // Wait for job list
      await this.page.waitForSelector(
        '.jobs-search-results-list, .scaffold-layout__list, [class*="jobs-search-results"]',
        { timeout: 15000 }
      );
      await randomDelay(2000, 3000);

      // Scroll to load more results
      for (let i = 0; i < 3; i++) {
        await this.page.evaluate(() => {
          const list = document.querySelector('.jobs-search-results-list, .scaffold-layout__list');
          if (list) list.scrollTop = list.scrollHeight;
        });
        await randomDelay(1000, 2000);
      }

      const jobCards = await this.page.$$(
        '.job-card-container, .jobs-search-results__list-item, [data-occludable-job-id], .scaffold-layout__list-item'
      );
      this.onLog('info', `[LinkedIn] ${jobCards.length} Stellenanzeigen gefunden`);

      for (const card of jobCards) {
        if (this.stopped) break;

        try {
          const title = await card.$eval(
            '.job-card-list__title, .job-card-container__link, [class*="job-title"], strong',
            el => el.textContent.trim()
          ).catch(() => '');

          const company = await card.$eval(
            '.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, [class*="company-name"]',
            el => el.textContent.trim()
          ).catch(() => '');

          const location = await card.$eval(
            '.job-card-container__metadata-item, .artdeco-entity-lockup__caption, [class*="job-location"]',
            el => el.textContent.trim()
          ).catch(() => '');

          const link = await card.$eval(
            'a[href*="/jobs/view/"], a[href*="/jobs/search/"]',
            el => el.href
          ).catch(() => '');

          if (!title) continue;

          // Check exclude keywords
          const combined = `${title} ${company}`.toLowerCase();
          if (excludeKeywords.some(k => combined.includes(k))) {
            this.onLog('info', `[LinkedIn] Übersprungen (Ausschlusswort): ${title} @ ${company}`);
            continue;
          }

          const jobId = this._extractJobId(link);

          const job = {
            job_title: title,
            company,
            location,
            salary_info: '',
            job_url: link,
            indeed_job_id: `li_${jobId}`,
            platform: 'linkedin'
          };

          jobs.push(job);
          this.jobsFound++;
          this.onJobFound(job);
        } catch (err) {
          this.onLog('warn', `[LinkedIn] Fehler beim Parsen: ${err.message}`);
        }
      }
    } catch (err) {
      this.onLog('error', `[LinkedIn] Fehler beim Parsen der Ergebnisse: ${err.message}`);
      await this._screenshot('linkedin_parse_error');
    }

    return jobs;
  }

  async applyToJob(job) {
    if (this.stopped) return false;

    this.onLog('info', `[LinkedIn] Bewerbe mich: ${job.job_title} @ ${job.company}`);
    this.onProgress({ action: 'applying', job: job.job_title, company: job.company, platform: 'linkedin' });

    try {
      if (job.job_url) {
        await this.page.goto(job.job_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomDelay(2000, 4000);
      }

      // Get job description
      const description = await this.page.$eval(
        '.jobs-description, [class*="jobs-description"], .jobs-box__html-content',
        el => el.textContent.trim().slice(0, 5000)
      ).catch(() => '');
      job.job_description = description;

      // Look for Easy Apply button
      const easyApplyBtn = await this.page.$(
        'button.jobs-apply-button, button[class*="jobs-apply-button"], button:has-text("Easy Apply"), button:has-text("Einfach bewerben")'
      );

      if (!easyApplyBtn) {
        this.onLog('info', `[LinkedIn] Kein Easy-Apply für: ${job.job_title} — als "gefunden" gespeichert`);
        job.status = 'found';
        return false;
      }

      // Check if it's actually "Easy Apply"
      const btnText = await easyApplyBtn.textContent().catch(() => '');
      if (!btnText.toLowerCase().includes('easy') && !btnText.toLowerCase().includes('einfach')) {
        this.onLog('info', `[LinkedIn] Externe Bewerbung für: ${job.job_title} — übersprungen`);
        job.status = 'found';
        return false;
      }

      await easyApplyBtn.click();
      await randomDelay(2000, 4000);

      // Handle Easy Apply modal
      const applied = await this._fillEasyApplyForm();

      if (applied) {
        this.jobsApplied++;
        this.onApplied(job);
        this.onLog('info', `[LinkedIn] Bewerbung gesendet: ${job.job_title} @ ${job.company}`);
        return true;
      }

      // Close modal if still open
      const closeBtn = await this.page.$('button[aria-label="Dismiss"], button[aria-label="Schließen"]');
      if (closeBtn) {
        await closeBtn.click();
        await randomDelay(500, 1000);
        // Confirm discard
        const discardBtn = await this.page.$('button[data-control-name="discard_application_confirm"], button:has-text("Verwerfen"), button:has-text("Discard")');
        if (discardBtn) await discardBtn.click();
      }

      this.onLog('warn', `[LinkedIn] Bewerbungsformular konnte nicht ausgefüllt werden: ${job.job_title}`);
      job.status = 'found';
      return false;

    } catch (err) {
      this.onLog('error', `[LinkedIn] Fehler bei Bewerbung: ${err.message}`);
      await this._screenshot(`linkedin_apply_error_${Date.now()}`);
      return false;
    }
  }

  async _fillEasyApplyForm() {
    try {
      await randomDelay(1500, 2500);

      // LinkedIn Easy Apply is a multi-step modal
      let maxSteps = 8;
      while (maxSteps > 0 && !this.stopped) {
        maxSteps--;

        // Wait for modal content
        await this.page.waitForSelector(
          '.jobs-easy-apply-modal, [class*="jobs-easy-apply"], [role="dialog"]',
          { timeout: 5000 }
        ).catch(() => {});

        // Fill contact info if visible
        await this._fillField('input[name*="firstName"], input[id*="firstName"]', this.profile.full_name?.split(' ')[0] || '');
        await this._fillField('input[name*="lastName"], input[id*="lastName"]', this.profile.full_name?.split(' ').slice(1).join(' ') || '');
        await this._fillField('input[name*="email"], input[id*="email"]', this.profile.email);
        await this._fillField('input[name*="phone"], input[id*="phone"], input[name*="phoneNumber"]', this.profile.phone);
        await this._fillField('input[name*="city"], input[id*="city"]', this.profile.location);

        // Upload resume if file input available
        if (this.profile.resume_data) {
          await this._uploadResume();
        }

        // Check for "Submit application" / "Bewerbung senden" button
        const submitBtn = await this.page.$(
          'button[aria-label*="Submit"], button[aria-label*="Bewerbung senden"], button:has-text("Submit application"), button:has-text("Bewerbung senden")'
        );

        if (submitBtn) {
          if (this.prefs.auto_apply) {
            await submitBtn.click();
            await randomDelay(2000, 3000);

            // Check for success message
            const success = await this.page.$('[class*="post-apply"], [class*="artdeco-inline-feedback--success"]');
            if (success) {
              this.onLog('info', '[LinkedIn] Bewerbung erfolgreich abgesendet!');

              // Close success modal
              const doneBtn = await this.page.$('button:has-text("Done"), button:has-text("Fertig"), button[aria-label="Dismiss"]');
              if (doneBtn) await doneBtn.click();

              return true;
            }

            // Might have additional steps even after clicking submit
            this.onLog('info', '[LinkedIn] Bewerbung abgesendet');
            return true;
          } else {
            this.onLog('info', '[LinkedIn] Auto-Apply deaktiviert — Bewerbung vorbereitet');
            return false;
          }
        }

        // Look for "Next" / "Review" / "Weiter" button
        const nextBtn = await this.page.$(
          'button[aria-label*="Continue"], button[aria-label*="Next"], button[aria-label*="Review"], button[aria-label*="Weiter"], footer button.artdeco-button--primary'
        );

        if (nextBtn) {
          const nextText = await nextBtn.textContent().catch(() => '');
          this.onLog('info', `[LinkedIn] Nächster Schritt: ${nextText.trim()}`);
          await nextBtn.click();
          await randomDelay(1500, 3000);
          continue;
        }

        // No next or submit button found
        break;
      }

      return false;
    } catch (err) {
      this.onLog('warn', `[LinkedIn] Formular-Fehler: ${err.message}`);
      return false;
    }
  }

  async _fillField(selector, value) {
    if (!value) return;
    try {
      const field = await this.page.$(selector);
      if (field) {
        const currentVal = await field.inputValue().catch(() => '');
        if (currentVal) return; // Don't overwrite pre-filled fields
        await field.click();
        await field.fill(value);
        await randomDelay(200, 500);
      }
    } catch {}
  }

  async _uploadResume() {
    try {
      const fileInput = await this.page.$('input[type="file"]');
      if (fileInput && this.profile.resume_filename) {
        const fs = require('fs');
        const tmpPath = path.join(SCREENSHOT_DIR, `resume_li_${this.userId}_${this.profile.resume_filename}`);
        if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(tmpPath, this.profile.resume_data);
        await fileInput.setInputFiles(tmpPath);
        await randomDelay(1000, 2000);
        try { fs.unlinkSync(tmpPath); } catch {}
        this.onLog('info', '[LinkedIn] Lebenslauf hochgeladen');
      }
    } catch (err) {
      this.onLog('warn', `[LinkedIn] Lebenslauf-Upload fehlgeschlagen: ${err.message}`);
    }
  }

  async _checkBlocked() {
    try {
      const content = await this.page.content();
      return content.includes('authwall') ||
             content.includes('restricted') ||
             content.includes('unusual activity') ||
             content.includes('security verification');
    } catch {
      return false;
    }
  }

  _extractJobId(url) {
    if (!url) return '';
    const match = url.match(/\/view\/(\d+)/);
    return match ? match[1] : '';
  }

  async _screenshot(name) {
    try {
      const fs = require('fs');
      if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await this.page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${name}_${Date.now()}.png`),
        fullPage: false
      });
    } catch {}
  }

  async stop() {
    this.stopped = true;
    this.onLog('info', '[LinkedIn] Automation wird gestoppt...');
    try {
      if (this.browser) await this.browser.close();
    } catch {}
    this.onLog('info', '[LinkedIn] Automation gestoppt');
  }
}

module.exports = LinkedInAutomation;
