require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const path    = require('path');
const jwt     = require('jsonwebtoken');
const { init, getDb } = require('./src/database');
const { JWT_SECRET }  = require('./src/middleware');

init();

const ADMIN_PORT = process.env.ADMIN_PORT || 8200;
const USER_PORT  = process.env.USER_PORT  || 8201;

// ── Agent store: userId → { socket, info, stats, connectedAt } ──
const agents = new Map();
module.exports.agents = agents;

// ── Broadcast to all admin dashboard sockets ──
const adminSockets = new Set();
function broadcastAdmin(event, data) {
  adminSockets.forEach(s => s.emit(event, data));
}

// ─────────────────────────────────────────────
// ADMIN SERVER (port 8200)
// ─────────────────────────────────────────────
const adminApp = express();
adminApp.use(cors());
adminApp.use(express.json());
adminApp.use(express.static(path.join(__dirname, 'public', 'admin')));
adminApp.use('/assets', express.static(path.join(__dirname, 'assets')));
adminApp.use('/api/auth',  require('./src/routes/auth'));
adminApp.use('/api/admin', require('./src/routes/admin'));

// Admin: send command to a specific agent
adminApp.post('/api/admin/agent/:userId/execute', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
  } catch { return res.status(403).json({ error: 'Invalid token' }); }

  const agent = agents.get(req.params.userId);
  if (!agent) return res.status(404).json({ error: 'Agent nicht verbunden' });

  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Kein Befehl' });

  const execId = 'adm_' + Date.now();
  agent.socket.emit('execute', { id: execId, command });

  const timeout = setTimeout(() => {
    agent.socket.off('result_' + execId);
    if (!res.headersSent) res.status(408).json({ error: 'Timeout' });
  }, 30000);

  agent.socket.once('result_' + execId, (data) => {
    clearTimeout(timeout);
    if (!res.headersSent) res.json({ output: data.output, exitCode: data.exitCode, error: data.error });
  });
});

// Admin: list connected agents
adminApp.get('/api/admin/agents/live', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(token, JWT_SECRET); } catch { return res.status(403).json({ error: 'Invalid token' }); }

  const list = [];
  agents.forEach((agent, userId) => {
    list.push({
      userId,
      info:        agent.info || {},
      stats:       agent.stats || {},
      connectedAt: agent.connectedAt,
      lastSeen:    agent.lastSeen,
    });
  });
  res.json(list);
});

adminApp.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

const adminServer = http.createServer(adminApp);

// Admin Socket.io — live dashboard feed
const adminIo = new Server(adminServer, { cors: { origin: '*' } });
adminIo.on('connection', (socket) => {
  const authHeader = socket.handshake.auth?.token;
  try {
    const decoded = jwt.verify(authHeader, JWT_SECRET);
    if (decoded.role !== 'admin') { socket.disconnect(); return; }
    adminSockets.add(socket);

    // Send current state immediately
    const list = [];
    agents.forEach((agent, userId) => list.push({ userId, info: agent.info||{}, stats: agent.stats||{}, connectedAt: agent.connectedAt, lastSeen: agent.lastSeen }));
    socket.emit('agents_snapshot', list);

    socket.on('disconnect', () => adminSockets.delete(socket));
  } catch {
    socket.disconnect();
  }
});

adminServer.listen(ADMIN_PORT, '0.0.0.0', () => {
  console.log(`\x1b[36m[CORTEX]\x1b[0m Admin Dashboard  → port ${ADMIN_PORT}`);
});

// ─────────────────────────────────────────────
// USER SERVER (port 8201)
// ─────────────────────────────────────────────
const userApp = express();
userApp.use(cors());
userApp.use(express.json());
userApp.use(express.static(path.join(__dirname, 'public', 'user')));
userApp.use('/assets', express.static(path.join(__dirname, 'assets')));

// ── Agent version + live code endpoint ──
const crypto = require('crypto');
const fs = require('fs');
const AGENT_JS = path.join(__dirname, 'cortex-agent', 'agent.js');

function getAgentVersion() {
  try {
    const src = fs.readFileSync(AGENT_JS, 'utf8');
    return crypto.createHash('md5').update(src).digest('hex').slice(0, 8);
  } catch { return '0'; }
}

// Launcher fetches this to check/get latest agent code
userApp.get('/api/agent/version', (req, res) => {
  res.json({ version: getAgentVersion() });
});
userApp.get('/api/agent/latest', (req, res) => {
  res.sendFile(AGENT_JS);
});
userApp.get('/api/agent/deps', (req, res) => {
  res.sendFile(path.join(__dirname, 'cortex-agent', 'deps', 'socket-io-client.zip'));
});

// Downloads
userApp.get('/download/cortex-agent.js', (req, res) =>
  res.download(AGENT_JS, 'cortex-agent.js'));
userApp.get('/download/CORTEX-Launcher-Windows.exe', (req, res) =>
  res.download(path.join(__dirname, 'cortex-agent', 'dist', 'CORTEX-Launcher-Windows.exe')));
userApp.get('/download/CORTEX-Launcher-Mac.zip', (req, res) =>
  res.download(path.join(__dirname, 'cortex-agent', 'dist', 'CORTEX-Launcher-Mac.zip')));
// Legacy names
userApp.get('/download/CORTEX-Agent-Windows.exe', (req, res) =>
  res.download(path.join(__dirname, 'cortex-agent', 'dist', 'CORTEX-Launcher-Windows.exe'), 'CORTEX-Launcher-Windows.exe'));
userApp.get('/download/CORTEX-Agent-Mac.zip', (req, res) =>
  res.download(path.join(__dirname, 'cortex-agent', 'dist', 'CORTEX-Launcher-Mac.zip'), 'CORTEX-Launcher-Mac.zip'));

userApp.use('/api/auth', require('./src/routes/auth'));
userApp.use('/api/chat', require('./src/routes/chat'));

// Agent status
userApp.get('/api/agent/status', (req, res) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.json({ connected: false });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const agent = agents.get(decoded.userId);
    res.json({ connected: !!agent, stats: agent?.stats || null, info: agent?.info || null });
  } catch { res.json({ connected: false }); }
});

// Execute command via agent (from user chat)
userApp.post('/api/agent/execute', (req, res) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const agent = agents.get(decoded.userId);
    if (!agent) return res.status(404).json({ error: 'Kein Desktop-Agent verbunden' });

    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Kein Befehl' });

    const execId = Date.now().toString();
    agent.socket.emit('execute', { id: execId, command });

    const timeout = setTimeout(() => {
      agent.socket.off('result_' + execId);
      if (!res.headersSent) res.status(408).json({ error: 'Timeout – Agent hat nicht geantwortet' });
    }, 30000);

    agent.socket.once('result_' + execId, (data) => {
      clearTimeout(timeout);
      if (!res.headersSent) res.json({ output: data.output, exitCode: data.exitCode, error: data.error });
    });
  } catch { res.status(403).json({ error: 'Invalid token' }); }
});

userApp.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user', 'index.html')));

const userServer = http.createServer(userApp);

// ── Desktop Agent Socket.io ──
const agentIo = new Server(userServer, { cors: { origin: '*' } });

agentIo.on('connection', (socket) => {
  socket.on('auth', (data) => {
    try {
      const decoded = jwt.verify(data.token, JWT_SECRET);
      const userId = decoded.userId;

      // Get user info from DB
      const db = getDb();
      const user = db.prepare('SELECT name, email, company FROM users WHERE id = ?').get(userId);

      const agentEntry = {
        socket,
        userId,
        userName:    user?.name    || 'Unknown',
        userEmail:   user?.email   || '',
        userCompany: user?.company || '',
        info:        {},
        stats:       {},
        connectedAt: new Date().toISOString(),
        lastSeen:    new Date().toISOString(),
      };

      agents.set(userId, agentEntry);
      socket.userId = userId;

      socket.emit('auth_ok', { userId });
      console.log(`\x1b[32m[CORTEX]\x1b[0m Agent connected: ${user?.name} (${user?.email})`);

      // Broadcast to admin dashboards
      broadcastAdmin('agent_connected', {
        userId,
        userName:    agentEntry.userName,
        userEmail:   agentEntry.userEmail,
        userCompany: agentEntry.userCompany,
        connectedAt: agentEntry.connectedAt,
      });

      // Receive system info
      socket.on('sysinfo', (info) => {
        agentEntry.info = info;
        agentEntry.lastSeen = new Date().toISOString();
        broadcastAdmin('agent_info', { userId, info });
      });

      // Receive periodic stats heartbeat
      socket.on('stats', (stats) => {
        agentEntry.stats = stats;
        agentEntry.lastSeen = new Date().toISOString();
        broadcastAdmin('agent_stats', { userId, stats, lastSeen: agentEntry.lastSeen });
      });

      // Forward results
      socket.on('result', (data) => {
        socket.emit('result_' + data.id, data);
        broadcastAdmin('agent_result', { userId, ...data });
      });

      socket.on('disconnect', () => {
        agents.delete(userId);
        console.log(`\x1b[33m[CORTEX]\x1b[0m Agent disconnected: ${user?.name}`);
        broadcastAdmin('agent_disconnected', { userId });
      });

    } catch {
      socket.emit('auth_error', { error: 'Invalid token' });
      socket.disconnect();
    }
  });
});

userServer.listen(USER_PORT, '0.0.0.0', () => {
  console.log(`\x1b[36m[CORTEX]\x1b[0m User Panel + Agent → port ${USER_PORT}`);
});

console.log(`\x1b[32m[CORTEX]\x1b[0m CORTEX IT Support Agent gestartet`);
