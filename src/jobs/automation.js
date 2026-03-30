const { chromium } = require('playwright');
const path = require('path');

const HEADLESS = process.env.JOB_BROWSER_HEADLESS !== 'false';
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'screenshots');

function randomDelay(min = 2000, max = 6000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

class JobAutomation {
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
  }

  async launch() {
    this.onLog('info', 'Browser wird gestartet...');
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

    // Stealth: hide automation indicators
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de', 'en-US', 'en'] });
    });

    this.page = await context.newPage();
    this.onLog('info', 'Browser gestartet');
  }

  async searchJobs() {
    if (this.stopped) return [];

    const keywords = JSON.parse(this.prefs.keywords || '[]');
    const location = this.prefs.location || '';
    const query = keywords.join(' ');

    if (!query) {
      this.onLog('error', 'Keine Suchbegriffe konfiguriert');
      return [];
    }

    this.onLog('info', `Suche: "${query}" in "${location || 'Überall'}"`);

    // Build Indeed URL
    const params = new URLSearchParams();
    params.set('q', query);
    if (location) params.set('l', location);
    if (this.prefs.radius_km) params.set('radius', String(this.prefs.radius_km));

    const jobTypeMap = {
      fulltime: 'fulltime',
      parttime: 'parttime',
      contract: 'contract',
      temporary: 'temporary',
      internship: 'internship'
    };
    if (this.prefs.job_type && jobTypeMap[this.prefs.job_type]) {
      params.set('jt', jobTypeMap[this.prefs.job_type]);
    }

    const url = `https://de.indeed.com/jobs?${params.toString()}`;
    this.onLog('info', `Öffne Indeed: ${url}`);

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomDelay(3000, 5000);
    } catch (err) {
      this.onLog('error', `Seite konnte nicht geladen werden: ${err.message}`);
      await this._screenshot('load_error');
      return [];
    }

    // Check for captcha/block
    const blocked = await this._checkBlocked();
    if (blocked) {
      this.onLog('warn', 'Indeed hat uns möglicherweise blockiert (Captcha/Block erkannt)');
      await this._screenshot('blocked');
      return [];
    }

    return await this.parseResults();
  }

  async parseResults() {
    const jobs = [];
    const excludeKeywords = JSON.parse(this.prefs.exclude_keywords || '[]').map(k => k.toLowerCase());

    try {
      // Wait for job cards to load
      await this.page.waitForSelector('[class*="job_seen_beacon"], [class*="resultContent"], .jobsearch-ResultsList', { timeout: 15000 });
      await randomDelay(1000, 2000);

      const jobCards = await this.page.$$('[class*="job_seen_beacon"], .result, [data-testid="slider_item"]');
      this.onLog('info', `${jobCards.length} Stellenanzeigen gefunden`);

      for (const card of jobCards) {
        if (this.stopped) break;

        try {
          const title = await card.$eval(
            '[class*="jobTitle"] a, .jobTitle a, h2 a',
            el => el.textContent.trim()
          ).catch(() => '');

          const company = await card.$eval(
            '[data-testid="company-name"], .companyName, [class*="company"]',
            el => el.textContent.trim()
          ).catch(() => '');

          const location = await card.$eval(
            '[data-testid="text-location"], .companyLocation, [class*="location"]',
            el => el.textContent.trim()
          ).catch(() => '');

          const salary = await card.$eval(
            '[class*="salary"], .salary-snippet, [data-testid="attribute_snippet_testid"]',
            el => el.textContent.trim()
          ).catch(() => '');

          const link = await card.$eval(
            '[class*="jobTitle"] a, .jobTitle a, h2 a',
            el => el.href
          ).catch(() => '');

          if (!title) continue;

          // Check exclude keywords
          const combined = `${title} ${company}`.toLowerCase();
          if (excludeKeywords.some(k => combined.includes(k))) {
            this.onLog('info', `Übersprungen (Ausschlusswort): ${title} @ ${company}`);
            continue;
          }

          const job = {
            job_title: title,
            company,
            location,
            salary_info: salary,
            job_url: link,
            indeed_job_id: this._extractJobId(link)
          };

          jobs.push(job);
          this.jobsFound++;
          this.onJobFound(job);
        } catch (err) {
          this.onLog('warn', `Fehler beim Parsen einer Stellenanzeige: ${err.message}`);
        }
      }
    } catch (err) {
      this.onLog('error', `Fehler beim Parsen der Ergebnisse: ${err.message}`);
      await this._screenshot('parse_error');
    }

    return jobs;
  }

  async applyToJob(job) {
    if (this.stopped) return false;

    this.onLog('info', `Bewerbe mich: ${job.job_title} @ ${job.company}`);
    this.onProgress({ action: 'applying', job: job.job_title, company: job.company });

    try {
      // Navigate to job listing
      if (job.job_url) {
        await this.page.goto(job.job_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomDelay(2000, 4000);
      }

      // Get job description for records
      const description = await this.page.$eval(
        '#jobDescriptionText, [class*="jobDescription"], .jobsearch-jobDescriptionText',
        el => el.textContent.trim().slice(0, 5000)
      ).catch(() => '');
      job.job_description = description;

      // Look for "Jetzt bewerben" / "Apply Now" button
      const applyBtn = await this.page.$(
        'button[id*="apply"], [class*="apply"] button, button:has-text("bewerben"), button:has-text("Apply"), #indeedApplyButton'
      );

      if (!applyBtn) {
        this.onLog('info', `Kein Easy-Apply Button gefunden für: ${job.job_title} — Wird als "gefunden" gespeichert`);
        job.status = 'found';
        return false;
      }

      await applyBtn.click();
      await randomDelay(2000, 4000);

      // Handle the application form
      const applied = await this._fillApplicationForm();

      if (applied) {
        this.jobsApplied++;
        this.onApplied(job);
        this.onLog('info', `Bewerbung gesendet: ${job.job_title} @ ${job.company}`);
        return true;
      }

      this.onLog('warn', `Konnte Bewerbungsformular nicht ausfüllen: ${job.job_title}`);
      job.status = 'found';
      return false;

    } catch (err) {
      this.onLog('error', `Fehler bei Bewerbung für ${job.job_title}: ${err.message}`);
      await this._screenshot(`apply_error_${Date.now()}`);
      return false;
    }
  }

  async _fillApplicationForm() {
    try {
      // Wait for form or iframe to appear
      await randomDelay(1500, 3000);

      // Check if Indeed opened application in iframe or new page
      const frames = this.page.frames();
      let formFrame = this.page;

      for (const frame of frames) {
        const hasForm = await frame.$('form[class*="apply"], form[id*="apply"], [class*="ia-container"]').catch(() => null);
        if (hasForm) {
          formFrame = frame;
          break;
        }
      }

      // Fill name fields
      await this._fillField(formFrame, 'input[name*="name"], input[id*="name"], input[aria-label*="Name"]', this.profile.full_name);

      // Fill email
      await this._fillField(formFrame, 'input[type="email"], input[name*="email"], input[id*="email"]', this.profile.email);

      // Fill phone
      await this._fillField(formFrame, 'input[type="tel"], input[name*="phone"], input[id*="phone"]', this.profile.phone);

      // Upload resume if available
      if (this.profile.resume_data) {
        await this._uploadResume(formFrame);
      }

      await randomDelay(1000, 2000);

      // Try to find and click Continue/Submit buttons through multi-step forms
      let maxSteps = 5;
      while (maxSteps > 0 && !this.stopped) {
        maxSteps--;

        // Check for submit button
        const submitBtn = await formFrame.$(
          'button[type="submit"]:has-text("Senden"), button:has-text("Submit"), button:has-text("Bewerbung"), button[class*="submit"]'
        );

        if (submitBtn) {
          const btnText = await submitBtn.textContent().catch(() => '');
          if (btnText.toLowerCase().includes('send') || btnText.toLowerCase().includes('submit') ||
              btnText.toLowerCase().includes('bewerbung') || btnText.toLowerCase().includes('absenden')) {

            if (this.prefs.auto_apply) {
              await submitBtn.click();
              await randomDelay(2000, 3000);
              this.onLog('info', 'Bewerbung abgesendet!');
              return true;
            } else {
              this.onLog('info', 'Auto-Apply ist deaktiviert — Bewerbung vorbereitet aber nicht abgesendet');
              return false;
            }
          }
        }

        // Look for "Continue" / "Weiter" button for multi-step forms
        const continueBtn = await formFrame.$(
          'button:has-text("Continue"), button:has-text("Weiter"), button:has-text("Next"), [class*="continue"]'
        );

        if (continueBtn) {
          await continueBtn.click();
          await randomDelay(1500, 3000);

          // Fill any new fields that appeared
          await this._fillField(formFrame, 'input[type="email"]', this.profile.email);
          await this._fillField(formFrame, 'input[type="tel"]', this.profile.phone);
          continue;
        }

        break;
      }

      return false;
    } catch (err) {
      this.onLog('warn', `Formular-Fehler: ${err.message}`);
      return false;
    }
  }

  async _fillField(frame, selector, value) {
    if (!value) return;
    try {
      const field = await frame.$(selector);
      if (field) {
        await field.click();
        await field.fill('');
        await field.type(value, { delay: 30 + Math.random() * 50 });
        await randomDelay(300, 800);
      }
    } catch {}
  }

  async _uploadResume(frame) {
    try {
      const fileInput = await frame.$('input[type="file"]');
      if (fileInput && this.profile.resume_filename) {
        // Write temp file for upload
        const fs = require('fs');
        const tmpPath = path.join(SCREENSHOT_DIR, `resume_${this.userId}_${this.profile.resume_filename}`);
        fs.writeFileSync(tmpPath, this.profile.resume_data);
        await fileInput.setInputFiles(tmpPath);
        await randomDelay(1000, 2000);
        // Clean up temp file
        try { fs.unlinkSync(tmpPath); } catch {}
        this.onLog('info', 'Lebenslauf hochgeladen');
      }
    } catch (err) {
      this.onLog('warn', `Lebenslauf-Upload fehlgeschlagen: ${err.message}`);
    }
  }

  async _checkBlocked() {
    try {
      const content = await this.page.content();
      const blocked = content.includes('captcha') ||
                      content.includes('blocked') ||
                      content.includes('unusual traffic') ||
                      content.includes('Verdächtige Aktivität');
      return blocked;
    } catch {
      return false;
    }
  }

  _extractJobId(url) {
    if (!url) return '';
    const match = url.match(/jk=([a-f0-9]+)/i) || url.match(/\/([a-f0-9]{16})/);
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
    this.onLog('info', 'Automation wird gestoppt...');
    try {
      if (this.browser) await this.browser.close();
    } catch {}
    this.onLog('info', 'Automation gestoppt');
  }
}

module.exports = JobAutomation;
