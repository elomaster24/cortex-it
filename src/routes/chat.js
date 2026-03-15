const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken } = require('../middleware');

const router = express.Router();
router.use(authenticateToken);

const MODEL_MAP = {
  low: { id: 'claude-haiku-4-5-20251001', name: 'Haiku', tier: 'low', multiplier: 1 },
  medium: { id: 'claude-sonnet-4-6', name: 'Sonnet', tier: 'medium', multiplier: 3 },
  ultra: { id: 'claude-opus-4-6', name: 'Opus', tier: 'ultra', multiplier: 10 }
};

const BASE_SYSTEM_PROMPT = `Du bist CORTEX, ein hochkompetenter KI-IT-Support-Agent. Du bist der "digitale IT-Mitarbeiter" einer Firma — intelligent, präzise, proaktiv.

## Deine Persönlichkeit
- Professionell aber zugänglich — du erklärst technische Dinge verständlich
- Lösungsorientiert — du gibst konkrete Schritt-für-Schritt Anleitungen
- Proaktiv — du erkennst mögliche Folgprobleme und weist darauf hin
- Präzise — du gibst immer die exakten Befehle/Klickpfade an

## Deine Fähigkeiten
- Netzwerk & WLAN Diagnose und Reparatur
- Drucker Setup, Treiber, Verbindungsprobleme
- Outlook, Teams, Office 365 Konfiguration und Sync
- Windows & macOS Systemprobleme, Registry, Permissions
- Software Installation, Updates, Deinstallation
- Performance-Analyse und Optimierung (RAM, CPU, Disk)
- Sicherheit: Firewall, AV, Windows Defender
- Active Directory, VPN, Remote Desktop
- iCloud, OneDrive, SharePoint Sync
- Browser-Probleme (Cache, Extensions, Zertifikate)

## Antwortformat
- Nutze **Markdown** für strukturierte Antworten (##, ###, -, **, \`code\`)
- Befehle IMMER in Code-Blöcken mit Sprachkenner (bash, powershell, cmd)
- Nummerierte Schritte für Anleitungen
- Kurze Zusammenfassung am Anfang, Details darunter
- Wenn mehrere Lösungen möglich: priorisiere nach Wahrscheinlichkeit

## Wichtig
Bei jeder Antwort MUSS am Ende ein cortex-meta Block stehen:
\`\`\`cortex-meta
{"risk_level": "none|low|medium|high|critical", "changes": ["Änderung 1", "Änderung 2"]}
\`\`\`

Risk Levels:
- none: Nur Diagnose/Info, keine Systemänderungen
- low: Harmlose Einstellungen (WLAN neu verbinden, Cache leeren)
- medium: Konfigurationsänderungen (Druckertreiber, Netzwerkeinstellungen)
- high: Systemeingriffe (Registry, Systemdateien, Netzwerk-Reset)
- critical: Gefährliche Operationen (Factory Reset, Festplatten-Format, Datenlöschung)

Antworte auf Deutsch. Sei präzise und hilfreich.`;

function buildSystemPrompt(pcInfo) {
  if (!pcInfo) return BASE_SYSTEM_PROMPT;

  const pcContext = `
## Verbundener PC (Live-Daten)
- **Hostname:** ${pcInfo.hostname || 'Unbekannt'}
- **Betriebssystem:** ${pcInfo.platform || 'Unbekannt'} ${pcInfo.release || ''}
- **Architektur:** ${pcInfo.arch || 'Unbekannt'}
- **CPU:** ${pcInfo.cpuModel || 'Unbekannt'} (${pcInfo.cpus || '?'} Kerne)
- **RAM:** ${pcInfo.totalMem || 'Unbekannt'} gesamt, ${pcInfo.freeMem || '?'} frei
- **Benutzer:** ${pcInfo.user || 'Unbekannt'}
- **Uptime:** ${pcInfo.uptime || 'Unbekannt'}
${pcInfo.stats ? `- **CPU-Auslastung:** ${pcInfo.stats.cpu || 0}%
- **RAM-Auslastung:** ${pcInfo.stats.memPct || 0}% (${pcInfo.stats.memUsed || '?'} GB / ${pcInfo.stats.memTotal || '?'} GB)
- **Disk:** ${pcInfo.stats.disk || 'Unbekannt'}` : ''}

**Wichtig:** Passe alle Befehle und Anleitungen an dieses spezifische System an. Nutze die richtigen Befehle für ${pcInfo.platform === 'win32' ? 'Windows (PowerShell/CMD)' : pcInfo.platform === 'darwin' ? 'macOS (Terminal/zsh)' : 'Linux (bash)'}.`;

  return BASE_SYSTEM_PROMPT + '\n' + pcContext;
}

function parseMetaFromResponse(content) {
  const metaMatch = content.match(/```cortex-meta\s*\n([\s\S]*?)\n```/);
  let riskLevel = 'none';
  let changes = [];

  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      riskLevel = ['none','low','medium','high','critical'].includes(meta.risk_level) ? meta.risk_level : 'none';
      changes = Array.isArray(meta.changes) ? meta.changes : [];
    } catch {}
  }

  const cleanContent = content.replace(/```cortex-meta\s*\n[\s\S]*?\n```/g, '').trim();
  return { cleanContent, riskLevel, changes };
}

// Start new session
router.post('/session', (req, res) => {
  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(id, req.user.id);
  res.json({ sessionId: id });
});

// Get user sessions
router.get('/sessions', (req, res) => {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count,
      (SELECT content FROM messages WHERE session_id = s.id AND role = 'user' ORDER BY created_at ASC LIMIT 1) as first_message
    FROM sessions s WHERE s.user_id = ? ORDER BY s.started_at DESC
  `).all(req.user.id);
  res.json(sessions);
});

// Get session messages (only own sessions)
router.get('/session/:id/messages', (req, res) => {
  const db = getDb();
  const session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(req.params.id);
  res.json(messages);
});

function sanitizePcInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const allowed = ['hostname','platform','arch','release','totalMem','freeMem','cpus','cpuModel','uptime','user','stats'];
  const safe = {};
  for (const k of allowed) {
    if (raw[k] !== undefined) {
      if (k === 'stats' && typeof raw[k] === 'object') {
        safe[k] = {};
        for (const sk of ['cpu','memPct','memUsed','memTotal','freeMem','disk','platform','hostname']) {
          if (raw[k][sk] !== undefined) safe[k][sk] = String(raw[k][sk]).slice(0, 200);
        }
      } else {
        safe[k] = String(raw[k]).slice(0, 200);
      }
    }
  }
  return safe;
}

// Send message (streaming)
router.post('/message/stream', async (req, res) => {
  const { sessionId, content, tier = 'medium', pcInfo: rawPcInfo } = req.body;
  const pcInfo = sanitizePcInfo(rawPcInfo);
  if (!sessionId || !content) return res.status(400).json({ error: 'Session ID and content required' });

  const model = MODEL_MAP[tier] || MODEL_MAP.medium;
  const db = getDb();

  // Verify session belongs to user
  const session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });

  // Save user message
  const userMsgId = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, user_id, role, content, model) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userMsgId, sessionId, req.user.id, 'user', content, model.name);

  // Get conversation history
  const history = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const systemPrompt = buildSystemPrompt(pcInfo);
    let fullText = '';

    const stream = await client.messages.stream({
      model: model.id,
      max_tokens: 4096,
      system: systemPrompt,
      messages: history
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        fullText += chunk.delta.text;
        send('delta', { text: chunk.delta.text });
      }
    }

    const usage = await stream.finalUsage();
    const tokensUsed = (usage.input_tokens + usage.output_tokens) * model.multiplier;
    const { cleanContent, riskLevel, changes } = parseMetaFromResponse(fullText);

    // Save assistant message
    const assistMsgId = uuidv4();
    db.prepare(`INSERT INTO messages (id, session_id, user_id, role, content, model, tokens_used, risk_level, changes_made)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(assistMsgId, sessionId, req.user.id, 'assistant', cleanContent, model.name, tokensUsed, riskLevel, JSON.stringify(changes));

    // Update session
    db.prepare('UPDATE sessions SET model_used = ?, total_tokens = total_tokens + ? WHERE id = ?')
      .run(model.name, tokensUsed, sessionId);

    // Update token usage
    const month = new Date().toISOString().slice(0, 7);
    const tokenColumn = tier === 'low' ? 'haiku_tokens' : tier === 'ultra' ? 'opus_tokens' : 'sonnet_tokens';
    db.prepare(`INSERT INTO token_usage (user_id, month, ${tokenColumn}) VALUES (?, ?, ?)
      ON CONFLICT(user_id, month) DO UPDATE SET ${tokenColumn} = ${tokenColumn} + ?`)
      .run(req.user.id, month, tokensUsed, tokensUsed);

    db.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?").run(req.user.id);

    send('done', { message: cleanContent, riskLevel, changes, tokensUsed, model: model.name, tier, id: assistMsgId });
    res.end();
  } catch (err) {
    console.error('AI Error:', err.message);
    send('error', { error: 'AI service temporarily unavailable. Please try again.' });
    res.end();
  }
});

// Send message (non-streaming fallback)
router.post('/message', async (req, res) => {
  const { sessionId, content, tier = 'medium', pcInfo: rawPcInfo } = req.body;
  const pcInfo = sanitizePcInfo(rawPcInfo);
  if (!sessionId || !content) return res.status(400).json({ error: 'Session ID and content required' });

  const model = MODEL_MAP[tier] || MODEL_MAP.medium;
  const db = getDb();

  const session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden' });

  const userMsgId = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, user_id, role, content, model) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userMsgId, sessionId, req.user.id, 'user', content, model.name);

  const history = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const response = await client.messages.create({
      model: model.id,
      max_tokens: 4096,
      system: buildSystemPrompt(pcInfo),
      messages: history
    });

    if (!response.content || !response.content[0] || !response.content[0].text)
      throw new Error('Leere Antwort von AI erhalten');

    const rawResponse = response.content[0].text;
    const tokensUsed = (response.usage.input_tokens + response.usage.output_tokens) * model.multiplier;
    const { cleanContent, riskLevel, changes } = parseMetaFromResponse(rawResponse);

    const assistMsgId = uuidv4();
    db.prepare(`INSERT INTO messages (id, session_id, user_id, role, content, model, tokens_used, risk_level, changes_made)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(assistMsgId, sessionId, req.user.id, 'assistant', cleanContent, model.name, tokensUsed, riskLevel, JSON.stringify(changes));

    db.prepare('UPDATE sessions SET model_used = ?, total_tokens = total_tokens + ? WHERE id = ?')
      .run(model.name, tokensUsed, sessionId);

    const month = new Date().toISOString().slice(0, 7);
    const tokenColumn = tier === 'low' ? 'haiku_tokens' : tier === 'ultra' ? 'opus_tokens' : 'sonnet_tokens';
    db.prepare(`INSERT INTO token_usage (user_id, month, ${tokenColumn}) VALUES (?, ?, ?)
      ON CONFLICT(user_id, month) DO UPDATE SET ${tokenColumn} = ${tokenColumn} + ?`)
      .run(req.user.id, month, tokensUsed, tokensUsed);

    db.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?").run(req.user.id);

    res.json({ message: cleanContent, riskLevel, changes, tokensUsed, model: model.name, tier, id: assistMsgId });
  } catch (err) {
    console.error('AI Error:', err.message);
    res.status(500).json({ error: 'AI service temporarily unavailable. Please try again.' });
  }
});

// Get token usage for current user
router.get('/usage', (req, res) => {
  const db = getDb();
  const usage = db.prepare('SELECT * FROM token_usage WHERE user_id = ? ORDER BY month DESC').all(req.user.id);
  res.json(usage);
});

module.exports = router;
