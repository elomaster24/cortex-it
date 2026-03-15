#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════╗
 * ║         CORTEX Desktop Agent  v1.0.0            ║
 * ║    AI-Powered IT Support — Local PC Agent       ║
 * ╚══════════════════════════════════════════════════╝
 */

'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');
const readline = require('readline');

// ── Config paths ──────────────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), '.cortex-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SERVER_URL  = 'http://187.77.70.209:8201';

// ── Console helpers ───────────────────────────────────────────────────────────
const C = { reset:'\x1b[0m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', bold:'\x1b[1m', dim:'\x1b[2m' };

function banner() {
  console.clear();
  console.log(C.cyan + C.bold);
  console.log('  ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗');
  console.log(' ██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝');
  console.log(' ██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝ ');
  console.log(' ██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗ ');
  console.log(' ╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗');
  console.log('  ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝');
  console.log(C.reset + C.dim + '  Desktop Agent v1.0.0  ·  AI-Powered IT Support' + C.reset);
  console.log('');
}

function log(msg, type = 'info') {
  const icons = { info: C.cyan+'ℹ'+C.reset, ok: C.green+'✔'+C.reset, warn: C.yellow+'⚠'+C.reset, err: C.red+'✖'+C.reset };
  console.log(`  ${icons[type] || icons.info}  ${msg}`);
}

function hr() { console.log(C.dim + '  ' + '─'.repeat(52) + C.reset); }

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── First-run Setup ───────────────────────────────────────────────────────────
function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function firstRunSetup() {
  banner();
  console.log(C.bold + '  Ersteinrichtung' + C.reset);
  console.log(C.dim + '  Dieses Programm verbindet deinen PC mit dem CORTEX IT-Support Server.' + C.reset);
  console.log('');
  hr();
  console.log('');
  console.log('  ' + C.yellow + '1.' + C.reset + ' Öffne: ' + C.cyan + 'http://187.77.70.209:8201' + C.reset);
  console.log('  ' + C.yellow + '2.' + C.reset + ' Melde dich an');
  console.log('  ' + C.yellow + '3.' + C.reset + ' Klicke auf "Agent offline" oben → Token kopieren');
  console.log('');
  hr();
  console.log('');

  let token = '';
  while (!token || token.length < 20) {
    token = await prompt('  ' + C.bold + 'Agent-Token einfügen: ' + C.reset);
    if (token.length < 20) {
      log('Token zu kurz. Bitte nochmal versuchen.', 'err');
    }
  }

  const cfg = { token, server: SERVER_URL, hostname: os.hostname(), setupAt: new Date().toISOString() };
  saveConfig(cfg);
  console.log('');
  log('Konfiguration gespeichert!', 'ok');
  log(`Gespeichert in: ${CONFIG_FILE}`, 'info');
  console.log('');
  return cfg;
}

// ── System Info ───────────────────────────────────────────────────────────────
function getSysInfo() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    totalMem: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + ' GB',
    freeMem:  (os.freemem()  / 1024 / 1024 / 1024).toFixed(1) + ' GB',
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    uptime: Math.round(os.uptime() / 3600) + 'h',
    user: os.userInfo().username,
    cwd: process.cwd(),
  };
}

// ── Security: Blocklist ────────────────────────────────────────────────────────
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+[\/~]/i,
  /format\s+[a-z]:/i,
  /del\s+\/[sf]/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:(){ :|:& };:/,
  /curl.*\|\s*(?:bash|sh)/i,
  /wget.*\|\s*(?:bash|sh)/i,
];

function isBlocked(cmd) {
  return BLOCKED_PATTERNS.some(p => p.test(cmd));
}

// ── Execute Command ───────────────────────────────────────────────────────────
function runCommand(command, timeoutMs = 30000) {
  return new Promise(resolve => {
    if (isBlocked(command)) {
      resolve({ output: '', exitCode: -1, error: '[CORTEX] Befehl aus Sicherheitsgründen blockiert.' });
      return;
    }

    const platform = os.platform();
    const shell    = platform === 'win32' ? 'cmd.exe' : '/bin/bash';
    const flag     = platform === 'win32' ? '/c' : '-c';

    exec(command, { shell, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      resolve({
        output:   output.trim() || (err ? '' : '(Kein Output — Befehl erfolgreich)'),
        exitCode: err ? (err.code || 1) : 0,
        error:    (err && !stdout) ? err.message : null,
      });
    });
  });
}

// ── Auto-install deps ─────────────────────────────────────────────────────────
function downloadAndExtractDeps() {
  return new Promise((resolve, reject) => {
    const http  = require('http');
    const zlib  = require('zlib');
    const url   = `${SERVER_URL}/api/agent/deps`;
    const dest  = path.join(CONFIG_DIR, 'deps.zip');

    log('Lade socket.io-client herunter...', 'info');
    const file = fs.createWriteStream(dest);
    http.get(url, res => {
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        log('Entpacke...', 'info');
        const { execSync } = require('child_process');
        try {
          execSync(`unzip -o "${dest}" -d "${CONFIG_DIR}"`, { stdio: 'pipe' });
          fs.unlinkSync(dest);
          log('socket.io-client installiert!', 'ok');
          resolve();
        } catch (err) {
          reject(new Error('Entpacken fehlgeschlagen: ' + err.message));
        }
      });
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  banner();

  let cfg = loadConfig();

  if (!cfg) {
    cfg = await firstRunSetup();
    banner();
  }

  // Load socket.io-client — auto-install if missing
  let ioClient;
  try {
    ioClient = require('socket.io-client');
  } catch (e) {
    log('socket.io-client fehlt — lade vom Server...', 'warn');
    await downloadAndExtractDeps();
    try {
      ioClient = require(path.join(CONFIG_DIR, 'node_modules', 'socket.io-client'));
    } catch (e2) {
      log('Laden fehlgeschlagen: ' + e2.message, 'err');
      process.exit(1);
    }
  }

  log(`Server:    ${cfg.server}`, 'info');
  log(`PC:        ${os.hostname()} (${os.platform()}/${os.arch()})`, 'info');
  log(`User:      ${os.userInfo().username}`, 'info');
  hr();
  log('Verbinde mit CORTEX Server...', 'info');
  console.log('');

  const socket = ioClient(cfg.server, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 4000,
    reconnectionDelayMax: 15000,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    log('Verbunden! Authentifiziere...', 'ok');
    socket.emit('auth', { token: cfg.token });
  });

  // ── CPU usage helper ──────────────────────────────
  function getCpuUsage() {
    return new Promise(resolve => {
      const cpus1 = os.cpus();
      setTimeout(() => {
        const cpus2 = os.cpus();
        let idle = 0, total = 0;
        cpus2.forEach((cpu, i) => {
          const prev = cpus1[i];
          Object.keys(cpu.times).forEach(k => {
            const diff = cpu.times[k] - prev.times[k];
            total += diff;
            if (k === 'idle') idle += diff;
          });
        });
        resolve(Math.round((1 - idle / total) * 100));
      }, 500);
    });
  }

  function getDiskInfo() {
    return new Promise(resolve => {
      const cmd = os.platform() === 'win32'
        ? 'wmic logicaldisk get size,freespace,caption /format:csv'
        : 'df -h / | tail -1';
      exec(cmd, { timeout: 5000 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        resolve(stdout.trim().substring(0, 120));
      });
    });
  }

  async function sendStats() {
    const cpuPct = await getCpuUsage();
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;
    const memPct   = Math.round((usedMem / totalMem) * 100);
    const disk     = await getDiskInfo();

    socket.emit('stats', {
      cpu:     cpuPct,
      memPct,
      memUsed: (usedMem  / 1024 / 1024 / 1024).toFixed(1),
      memTotal:(totalMem / 1024 / 1024 / 1024).toFixed(1),
      freeMem: (freeMem  / 1024 / 1024 / 1024).toFixed(1),
      uptime:  Math.round(os.uptime() / 60),  // minutes
      disk,
      platform: os.platform(),
      hostname: os.hostname(),
      ts: new Date().toISOString(),
    });
  }

  socket.on('auth_ok', (data) => {
    console.log('');
    log(C.green + C.bold + 'CORTEX Agent ist aktiv!' + C.reset, 'ok');
    log('Der CORTEX IT-Support kann jetzt auf diesen PC zugreifen.', 'info');
    log('Drücke ' + C.bold + 'STRG+C' + C.reset + ' zum Beenden.', 'dim');
    hr();
    console.log('');

    // Send system info once
    socket.emit('sysinfo', getSysInfo());

    // Send stats immediately + every 10s
    sendStats();
    const statsInterval = setInterval(sendStats, 10000);
    socket.on('disconnect', () => clearInterval(statsInterval));

    // Listen for commands
    socket.on('execute', async (data) => {
      console.log('');
      log(C.yellow + '⚡ Befehl empfangen:' + C.reset, 'warn');
      console.log(C.dim + '    ' + (data.command || '').substring(0, 80) + C.reset);

      const result = await runCommand(data.command);

      if (result.exitCode === 0) {
        log('Ausgeführt ✔  (Exit 0)', 'ok');
      } else {
        log(`Fehler beim Ausführen (Exit ${result.exitCode})`, 'warn');
      }

      socket.emit('result', { id: data.id, ...result });
    });
  });

  socket.on('auth_error', (data) => {
    console.log('');
    log('Token ungültig: ' + data.error, 'err');
    log('Lösche Konfiguration und starte neu...', 'warn');

    // Delete config so next start triggers setup again
    try { fs.unlinkSync(CONFIG_FILE); } catch {}

    setTimeout(() => process.exit(1), 2000);
  });

  socket.on('disconnect', (reason) => {
    console.log('');
    log(`Verbindung getrennt (${reason}). Verbinde erneut...`, 'warn');
  });

  socket.on('connect_error', (err) => {
    log(`Verbindungsfehler: ${err.message}`, 'err');
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('');
    log('CORTEX Agent wird beendet...', 'warn');
    socket.disconnect();
    setTimeout(() => process.exit(0), 500);
  });

  // Keep process alive
  process.stdin.resume();
}

main().catch(e => {
  console.error('\n[CORTEX] Kritischer Fehler:', e.message);
  process.exit(1);
});
