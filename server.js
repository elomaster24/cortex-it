require('dotenv').config();
const express = require('express');
const http    = require('http');
const helmet  = require('helmet');
const { Server } = require('socket.io');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');
const fs      = require('fs');
const jwt     = require('jsonwebtoken');
const { init, getDb, auditLog } = require('./src/database');
const { JWT_SECRET, getTokenFromRequest }  = require('./src/middleware');

function parseCookies(cookieHeader) {
  return (cookieHeader || '').split(';').reduce((acc, c) => {
    const [k, ...v] = c.trim().split('=');
    if (k) try { acc[k.trim()] = decodeURIComponent(v.join('=')); } catch {}
    return acc;
  }, {});
}

// ── Warn if default JWT secret is used ──────────────────────────────────────
if (JWT_SECRET === 'cortex-secret-key-change-me') {
  console.warn('\x1b[31m[SECURITY]\x1b[0m Standard JWT_SECRET wird verwendet! Setze JWT_SECRET in .env!');
}

init();

const ADMIN_PORT = process.env.ADMIN_PORT || 8200;
const USER_PORT  = process.env.USER_PORT  || 8201;

// ── Agent store ──────────────────────────────────────────────────────────────
const agents = new Map();
module.exports.agents = agents;

// ── Broadcast to admin dashboards ──────────────────────────────────────────
const adminSockets = new Set();
function broadcastAdmin(event, data) {
  adminSockets.forEach(s => s.emit(event, data));
}

// ── Shared security middleware ───────────────────────────────────────────────
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://187.77.70.209:8200', 'http://187.77.70.209:8201', 'http://localhost:8200', 'http://localhost:8201'];

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true
};

// ── Rate limiter (in-memory) ─────────────────────────────────────────────────
const requestCounts = new Map();
function rateLimiter(maxReq, windowMs) {
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = requestCounts.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    entry.count++;
    requestCounts.set(key, entry);
    if (entry.count > maxReq) return res.status(429).json({ error: 'Zu viele Anfragen. Bitte warte kurz.' });
    next();
  };
}

// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  requestCounts.forEach((v, k) => { if (now > v.resetAt) requestCounts.delete(k); });
}, 300000);

// ─────────────────────────────────────────────
// ADMIN SERVER (port 8200)
// ─────────────────────────────────────────────
const adminApp = express();
adminApp.set('trust proxy', 1);
adminApp.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // inline scripts; migrate to external files in future
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
adminApp.use(cors(corsOptions));
adminApp.use(express.json({ limit: '50kb' }));
adminApp.use(express.static(path.join(__dirname, 'public', 'admin')));
adminApp.use('/assets', express.static(path.join(__dirname, 'assets')));
adminApp.use('/api/auth',  require('./src/routes/auth'));
adminApp.use('/api/admin', require('./src/routes/admin'));

// Admin: send command to a specific agent
adminApp.post('/api/admin/agent/:userId/execute', rateLimiter(60, 60000), (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  } catch { return res.status(403).json({ error: 'Invalid token' }); }

  const agent = agents.get(req.params.userId);
  if (!agent) return res.status(404).json({ error: 'Agent nicht verbunden' });

  const { command } = req.body;
  if (!command || typeof command !== 'string') return res.status(400).json({ error: 'Kein Befehl' });
  if (command.length > 2000) return res.status(400).json({ error: 'Befehl zu lang (max 2000 Zeichen)' });

  const execId = 'adm_' + crypto.randomBytes(8).toString('hex');
  auditLog(decoded.userId, 'admin_execute', req.params.userId, req.ip, { command: command.slice(0, 200) });
  agent.socket.emit('execute', { id: execId, command });

  const timeout = setTimeout(() => {
    agent.socket.off('result_' + execId);
    if (!res.headersSent) res.status(408).json({ error: 'Timeout' });
  }, 30000);

  agent.socket.once('result_' + execId, (data) => {
    clearTimeout(timeout);
    if (!res.headersSent) res.json({
      output: (data.output || '').slice(0, 50000),
      exitCode: data.exitCode,
      error: data.error ? String(data.error).slice(0, 500) : null
    });
  });
});

// Admin: list connected agents
adminApp.get('/api/admin/agents/live', (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  } catch { return res.status(403).json({ error: 'Invalid token' }); }

  const list = [];
  agents.forEach((agent, userId) => {
    list.push({ userId, info: agent.info || {}, stats: agent.stats || {}, connectedAt: agent.connectedAt, lastSeen: agent.lastSeen });
  });
  res.json(list);
});

adminApp.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

const adminServer = http.createServer(adminApp);

// Admin Socket.io
const adminIo = new Server(adminServer, {
  cors: corsOptions,
  maxHttpBufferSize: 1e5  // 100KB max
});
adminIo.on('connection', (socket) => {
  // Validate origin (CSRF protection for WebSocket)
  const origin = socket.handshake.headers.origin;
  if (origin && !CORS_ORIGINS.includes(origin)) {
    socket.disconnect();
    return;
  }

  // Read session from httpOnly cookie
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const sessionToken = cookies.session;

  try {
    const decoded = jwt.verify(sessionToken, JWT_SECRET);
    if (decoded.role !== 'admin') { socket.disconnect(); return; }
    adminSockets.add(socket);

    const list = [];
    agents.forEach((agent, userId) => list.push({ userId, info: agent.info||{}, stats: agent.stats||{}, connectedAt: agent.connectedAt, lastSeen: agent.lastSeen }));
    socket.emit('agents_snapshot', list);

    // Idle timeout: disconnect after 2 hours of inactivity
    let idleTimer = setTimeout(() => socket.disconnect(), 2 * 60 * 60 * 1000);
    socket.onAny(() => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => socket.disconnect(), 2 * 60 * 60 * 1000);
    });

    socket.on('disconnect', () => {
      clearTimeout(idleTimer);
      adminSockets.delete(socket);
    });
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
userApp.set('trust proxy', 1);
userApp.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
userApp.use(cors(corsOptions));
userApp.use(express.json({ limit: '100kb' }));
userApp.use(express.static(path.join(__dirname, 'public', 'user')));
userApp.use('/assets', express.static(path.join(__dirname, 'assets')));

// ── Agent version + code endpoint ────────────────────────────────────────────
const AGENT_JS = path.join(__dirname, 'cortex-agent', 'agent.js');

function getAgentVersion() {
  try {
    const src = fs.readFileSync(AGENT_JS, 'utf8');
    return crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
  } catch { return '0'; }
}

// Agent download requires valid JWT token
userApp.get('/api/agent/version', (req, res) => res.json({ version: getAgentVersion() }));
userApp.get('/api/agent/latest', (req, res) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  try { jwt.verify(token, JWT_SECRET); } catch { return res.status(403).json({ error: 'Invalid token' }); }
  res.sendFile(AGENT_JS);
});
userApp.get('/api/agent/deps', (req, res) => {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  try { jwt.verify(token, JWT_SECRET); } catch { return res.status(403).json({ error: 'Invalid token' }); }
  res.sendFile(path.join(__dirname, 'cortex-agent', 'deps', 'socket-io-client.zip'));
});

// Downloads — only launcher binaries, not source
userApp.get('/download/CORTEX-Launcher-Windows.exe', (req, res) =>
  res.download(path.join(__dirname, 'cortex-agent', 'dist', 'CORTEX-Launcher-Windows.exe')));
userApp.get('/download/CORTEX-Launcher-Mac.zip', (req, res) =>
  res.download(path.join(__dirname, 'cortex-agent', 'dist', 'CORTEX-Launcher-Mac.zip')));
userApp.get('/download/CORTEX-Agent-Windows.exe', (req, res) =>
  res.download(path.join(__dirname, 'cortex-agent', 'dist', 'CORTEX-Launcher-Windows.exe'), 'CORTEX-Launcher-Windows.exe'));
userApp.get('/download/CORTEX-Agent-Mac.zip', (req, res) =>
  res.download(path.join(__dirname, 'cortex-agent', 'dist', 'CORTEX-Launcher-Mac.zip'), 'CORTEX-Launcher-Mac.zip'));

userApp.use('/api/auth', rateLimiter(30, 60000), require('./src/routes/auth'));
userApp.use('/api/chat', rateLimiter(60, 60000), require('./src/routes/chat'));

// Agent status
userApp.get('/api/agent/status', (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) return res.json({ connected: false });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const agent = agents.get(decoded.userId);
    res.json({ connected: !!agent, stats: agent?.stats || null, info: agent?.info || null });
  } catch { res.json({ connected: false }); }
});

// Execute command via agent
userApp.post('/api/agent/execute', rateLimiter(30, 60000), (req, res) => {
  const token = getTokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = db.prepare('SELECT is_active FROM users WHERE id = ?').get(decoded.userId);
    if (!user || !user.is_active) return res.status(403).json({ error: 'Konto deaktiviert' });

    const agent = agents.get(decoded.userId);
    if (!agent) return res.status(404).json({ error: 'Kein Desktop-Agent verbunden' });

    const { command } = req.body;
    if (!command || typeof command !== 'string') return res.status(400).json({ error: 'Kein Befehl' });
    if (command.length > 2000) return res.status(400).json({ error: 'Befehl zu lang' });

    const execId = crypto.randomBytes(8).toString('hex');
    auditLog(decoded.userId, 'user_execute', decoded.userId, req.ip, { command: command.slice(0, 200) });
    agent.socket.emit('execute', { id: execId, command });

    const timeout = setTimeout(() => {
      agent.socket.off('result_' + execId);
      if (!res.headersSent) res.status(408).json({ error: 'Timeout – Agent hat nicht geantwortet' });
    }, 30000);

    agent.socket.once('result_' + execId, (data) => {
      clearTimeout(timeout);
      if (!res.headersSent) res.json({
        output: (data.output || '').slice(0, 50000),
        exitCode: data.exitCode,
        error: data.error ? String(data.error).slice(0, 500) : null
      });
    });
  } catch { res.status(403).json({ error: 'Invalid token' }); }
});

userApp.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user', 'index.html')));

const userServer = http.createServer(userApp);

// ── Desktop Agent Socket.io ──────────────────────────────────────────────────
const agentIo = new Server(userServer, {
  cors: { origin: '*' },  // agents connect from anywhere
  maxHttpBufferSize: 1e6  // 1MB max payload
});

// Disconnect unauthenticated sockets after 10s
agentIo.on('connection', (socket) => {
  const authTimeout = setTimeout(() => {
    if (!socket.userId) socket.disconnect();
  }, 10000);

  socket.on('auth', (data) => {
    clearTimeout(authTimeout);
    if (!data?.token || typeof data.token !== 'string') {
      socket.emit('auth_error', { error: 'Token fehlt' });
      socket.disconnect();
      return;
    }
    try {
      const decoded = jwt.verify(data.token, JWT_SECRET);
      const userId = decoded.userId;

      const db = getDb();
      const user = db.prepare('SELECT name, email, company, is_active FROM users WHERE id = ?').get(userId);

      // Reject inactive users
      if (!user || !user.is_active) {
        socket.emit('auth_error', { error: 'Konto deaktiviert' });
        socket.disconnect();
        return;
      }

      const agentEntry = {
        socket,
        userId,
        userName:    user.name,
        userEmail:   user.email,
        userCompany: user.company,
        info:        {},
        stats:       {},
        connectedAt: new Date().toISOString(),
        lastSeen:    new Date().toISOString(),
      };

      agents.set(userId, agentEntry);
      socket.userId = userId;
      socket.emit('auth_ok', { userId });
      console.log(`\x1b[32m[CORTEX]\x1b[0m Agent connected: ${user.name} (${user.email})`);

      broadcastAdmin('agent_connected', {
        userId,
        userName:    user.name,
        userEmail:   user.email,
        userCompany: user.company,
        connectedAt: agentEntry.connectedAt,
      });

      socket.on('sysinfo', (info) => {
        if (typeof info !== 'object') return;
        agentEntry.info = info;
        agentEntry.lastSeen = new Date().toISOString();
        broadcastAdmin('agent_info', { userId, info });
      });

      socket.on('stats', (stats) => {
        if (typeof stats !== 'object') return;
        agentEntry.stats = stats;
        agentEntry.lastSeen = new Date().toISOString();
        broadcastAdmin('agent_stats', { userId, stats, lastSeen: agentEntry.lastSeen });
      });

      socket.on('result', (data) => {
        if (!data?.id) return;
        socket.emit('result_' + data.id, data);
        broadcastAdmin('agent_result', { userId, ...data });
      });

      socket.on('disconnect', () => {
        agents.delete(userId);
        console.log(`\x1b[33m[CORTEX]\x1b[0m Agent disconnected: ${user.name}`);
        broadcastAdmin('agent_disconnected', { userId });
      });

    } catch {
      socket.emit('auth_error', { error: 'Ungültiger Token' });
      socket.disconnect();
    }
  });
});

userServer.listen(USER_PORT, '0.0.0.0', () => {
  console.log(`\x1b[36m[CORTEX]\x1b[0m User Panel + Agent → port ${USER_PORT}`);
});

console.log(`\x1b[32m[CORTEX]\x1b[0m CORTEX IT Support Agent gestartet`);
