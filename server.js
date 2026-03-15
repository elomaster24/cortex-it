require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { init } = require('./src/database');

// Initialize database
init();

const ADMIN_PORT = process.env.ADMIN_PORT || 8200;
const USER_PORT = process.env.USER_PORT || 8201;

// ── Admin Server ──
const adminApp = express();
adminApp.use(cors());
adminApp.use(express.json());
adminApp.use(express.static(path.join(__dirname, 'public', 'admin')));
adminApp.use('/assets', express.static(path.join(__dirname, 'assets')));
adminApp.use('/api/auth', require('./src/routes/auth'));
adminApp.use('/api/admin', require('./src/routes/admin'));
adminApp.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

const adminServer = http.createServer(adminApp);
adminServer.listen(ADMIN_PORT, '0.0.0.0', () => {
  console.log(`\x1b[36m[CORTEX]\x1b[0m Admin Dashboard running on port ${ADMIN_PORT}`);
});

// ── User Server ──
const userApp = express();
userApp.use(cors());
userApp.use(express.json());
userApp.use(express.static(path.join(__dirname, 'public', 'user')));
userApp.use('/assets', express.static(path.join(__dirname, 'assets')));
userApp.use('/api/auth', require('./src/routes/auth'));
userApp.use('/api/chat', require('./src/routes/chat'));
userApp.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user', 'index.html')));

const userServer = http.createServer(userApp);
userServer.listen(USER_PORT, '0.0.0.0', () => {
  console.log(`\x1b[36m[CORTEX]\x1b[0m User Panel running on port ${USER_PORT}`);
});

console.log(`\x1b[32m[CORTEX]\x1b[0m CORTEX IT Support Agent started successfully`);
console.log(`\x1b[33m[CORTEX]\x1b[0m Admin: http://localhost:${ADMIN_PORT}`);
console.log(`\x1b[33m[CORTEX]\x1b[0m User:  http://localhost:${USER_PORT}`);
