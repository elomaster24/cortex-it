#!/usr/bin/env node
/**
 * CORTEX Launcher — lädt immer die neueste Agent-Version vom Server.
 * Diese Datei muss NIE aktualisiert werden.
 */
'use strict';

const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const { spawn } = require('child_process');
const readline  = require('readline');

const SERVER      = 'http://187.77.70.209:8201';
const CONFIG_DIR  = path.join(os.homedir(), '.cortex-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, '.config.json');
const AGENT_FILE  = path.join(CONFIG_DIR, 'agent.js');
const VER_FILE    = path.join(CONFIG_DIR, '.version');

const C = { r:'\x1b[0m', c:'\x1b[36m', g:'\x1b[32m', y:'\x1b[33m', red:'\x1b[31m', b:'\x1b[1m', d:'\x1b[2m' };

function log(msg, t='i') {
  const ic={i:C.c+'ℹ'+C.r, ok:C.g+'✔'+C.r, w:C.y+'⚠'+C.r, e:C.red+'✖'+C.r};
  console.log(`  ${ic[t]||ic.i}  ${msg}`);
}

function banner() {
  console.clear();
  console.log(C.c+C.b);
  console.log('  ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗');
  console.log(' ██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝');
  console.log(' ██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝ ');
  console.log(' ██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗ ');
  console.log(' ╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗');
  console.log('  ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝');
  console.log(C.r+C.d+'  Desktop Agent Launcher  ·  CORTEX IT Support'+C.r);
  console.log('');
}

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch {}
  return null;
}
function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR,{recursive:true});
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function prompt(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({input:process.stdin, output:process.stdout});
    rl.question(q, a => { rl.close(); resolve(a.trim()); });
  });
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function checkAndUpdate() {
  try {
    const res = await fetch(`${SERVER}/api/agent/version`);
    if (res.status !== 200) return false;
    const { version } = JSON.parse(res.body);
    const cached = fs.existsSync(VER_FILE) ? fs.readFileSync(VER_FILE,'utf8').trim() : '';

    if (version === cached && fs.existsSync(AGENT_FILE)) {
      log(`Agent ist aktuell (v${version})`, 'ok');
      return false; // no update needed
    }

    log(cached ? `Update verfügbar: v${cached} → v${version}` : `Lade Agent herunter (v${version})...`, 'w');
    const dl = await fetch(`${SERVER}/api/agent/latest`);
    if (dl.status !== 200) { log('Download fehlgeschlagen','e'); return false; }

    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR,{recursive:true});
    fs.writeFileSync(AGENT_FILE, dl.body, 'utf8');
    fs.writeFileSync(VER_FILE, version, 'utf8');
    log(`Agent v${version} installiert`, 'ok');
    return true;
  } catch (e) {
    if (fs.existsSync(AGENT_FILE)) {
      log(`Server nicht erreichbar — starte mit gecachter Version`, 'w');
      return false;
    }
    throw new Error('Kein Server und kein Cache: ' + e.message);
  }
}

function runAgent(token) {
  log('Starte Agent...', 'i');
  console.log('');
  const child = spawn(process.execPath, [AGENT_FILE, '--token', token, '--server', SERVER], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => {
    if (code === 42) {
      // Special exit code = restart requested (future use)
      log('Neustart...', 'w');
      setTimeout(() => runAgent(token), 1000);
    } else {
      process.exit(code || 0);
    }
  });
}

async function main() {
  banner();

  let cfg = loadConfig();

  // First run: ask for token
  if (!cfg || !cfg.token) {
    console.log(C.b+'  Ersteinrichtung'+C.r);
    console.log(C.d+'  ──────────────────────────────────────────────────'+C.r);
    console.log('');
    console.log('  '+C.y+'1.'+C.r+' Öffne: '+C.c+'http://187.77.70.209:8201'+C.r);
    console.log('  '+C.y+'2.'+C.r+' Melde dich an');
    console.log('  '+C.y+'3.'+C.r+' Klicke "Agent einrichten" → Token kopieren');
    console.log('');

    let token = '';
    while (!token || token.length < 20) {
      token = await prompt('  '+C.b+'Token einfügen: '+C.r);
      if (token.length < 20) log('Token zu kurz','e');
    }
    cfg = { token, server: SERVER };
    saveConfig(cfg);
    log('Konfiguration gespeichert!', 'ok');
    console.log('');
  }

  // Check for updates
  log(`Server: ${SERVER}`, 'i');
  log('Prüfe auf Updates...', 'i');
  await checkAndUpdate();
  console.log('');

  // Run the agent
  runAgent(cfg.token);
}

main().catch(e => {
  console.error('\n[CORTEX] Fehler:', e.message);
  process.stdin.resume();
  setTimeout(() => process.exit(1), 3000);
});
