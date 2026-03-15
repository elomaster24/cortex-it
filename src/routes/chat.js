const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken } = require('../middleware');

const router = express.Router();
router.use(authenticateToken);

const MODEL_MAP = {
  low: { id: 'claude-haiku-4-5-20251001', name: 'Haiku', tier: 'low', multiplier: 1 },
  medium: { id: 'claude-sonnet-4-6-20250514', name: 'Sonnet', tier: 'medium', multiplier: 3 },
  ultra: { id: 'claude-opus-4-6-20250514', name: 'Opus', tier: 'ultra', multiplier: 10 }
};

const SYSTEM_PROMPT = `Du bist CORTEX, ein professioneller KI-IT-Support-Agent. Du hilfst Mitarbeitern bei IT-Problemen auf ihrem lokalen PC.

Deine Fähigkeiten:
- WLAN-Probleme diagnostizieren und beheben
- Drucker-Verbindungen prüfen und einrichten
- Outlook-Probleme lösen (Konfiguration, Synchronisation, etc.)
- iCloud-Einstellungen und Synchronisation
- Allgemeine Windows/Mac IT-Probleme
- Software-Installation und Updates
- Netzwerk-Diagnose
- Dateisystem-Operationen

WICHTIG: Bei jeder Antwort musst du folgendes JSON-Objekt am ENDE deiner Antwort einfügen (in einem separaten Code-Block mit dem Tag "cortex-meta"):
\`\`\`cortex-meta
{"risk_level": "none|low|medium|high|critical", "changes": ["Beschreibung der Änderung 1", "Beschreibung der Änderung 2"]}
\`\`\`

Risk Levels:
- none: Nur Information/Diagnose, keine Änderungen
- low: Kleinere Einstellungsänderungen (z.B. WLAN neu verbinden)
- medium: System-Einstellungen ändern (z.B. Druckertreiber installieren)
- high: Wichtige Systemänderungen (z.B. Registry-Einträge, Netzwerk-Reset)
- critical: Potentiell gefährliche Operationen (z.B. System-Dateien ändern, Factory Reset)

Antworte immer auf Deutsch. Sei professionell, präzise und erkläre Schritte klar.
Wenn du Befehle vorschlägst, zeige sie in Code-Blöcken.
Warne den Nutzer bei risikoreichen Operationen.`;

function parseMetaFromResponse(content) {
  const metaMatch = content.match(/```cortex-meta\s*\n([\s\S]*?)\n```/);
  let riskLevel = 'none';
  let changes = [];

  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]);
      riskLevel = meta.risk_level || 'none';
      changes = meta.changes || [];
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

// Get session messages
router.get('/session/:id/messages', (req, res) => {
  const db = getDb();
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(req.params.id);
  res.json(messages);
});

// Send message
router.post('/message', async (req, res) => {
  const { sessionId, content, tier = 'medium' } = req.body;
  if (!sessionId || !content) return res.status(400).json({ error: 'Session ID and content required' });

  const model = MODEL_MAP[tier] || MODEL_MAP.medium;
  const db = getDb();

  // Save user message
  const userMsgId = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, user_id, role, content, model) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userMsgId, sessionId, req.user.id, 'user', content, model.name);

  // Get conversation history
  const history = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId)
    .map(m => ({ role: m.role === 'system' ? 'user' : m.role, content: m.content }));

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const response = await client.messages.create({
      model: model.id,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: history
    });

    const rawResponse = response.content[0].text;
    const tokensUsed = (response.usage.input_tokens + response.usage.output_tokens) * model.multiplier;
    const { cleanContent, riskLevel, changes } = parseMetaFromResponse(rawResponse);

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

    // Update last active
    db.prepare('UPDATE users SET last_active = datetime("now") WHERE id = ?').run(req.user.id);

    res.json({
      message: cleanContent,
      riskLevel,
      changes,
      tokensUsed,
      model: model.name,
      tier
    });
  } catch (err) {
    console.error('AI Error:', err.message);
    res.status(500).json({ error: 'AI service error: ' + err.message });
  }
});

// Get token usage for current user
router.get('/usage', (req, res) => {
  const db = getDb();
  const usage = db.prepare('SELECT * FROM token_usage WHERE user_id = ? ORDER BY month DESC').all(req.user.id);
  res.json(usage);
});

module.exports = router;
