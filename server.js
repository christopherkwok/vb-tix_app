#!/usr/bin/env node
/**
 * NYUrban Volleyball Ticket Tracker — All venues
 * Pure Node.js, zero dependencies
 */

const http = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
const url   = require('url');

const PORT          = 3333;
const AJAX_URL      = 'https://www.nyurban.com/wp-admin/admin-ajax.php';
const PAGE_URL      = 'https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1';
const NOTIF_FILE    = path.join(__dirname, 'notifications.json');

const VENUES = [
  { id: 'laguardia',    label: 'Laguardia / Fri',  filterId: 35, buttonId: 1 },
  { id: 'beacon',       label: 'Beacon / Fri',      filterId: 34, buttonId: 2 },
  { id: 'brandeis-fri', label: 'Brandeis / Fri',    filterId: 6,  buttonId: 3 },
  { id: 'brandeis-sun', label: 'Brandeis / Sun',    filterId: 18, buttonId: 4 },
  { id: 'clinics',      label: 'Clinics',           filterId: 32, buttonId: 5 },
];

// ── State ─────────────────────────────────────────────────────────────────────
let lastScrape   = null;
let allGames     = [];
let scrapeErrors = {};
let subscribers  = [];
let previousAvailableIds = new Set();

// ── Notification config ───────────────────────────────────────────────────────
// notifications.json schema:
// {
//   "email": "you@example.com",
//   "gmailUser": "sender@gmail.com",
//   "gmailPass": "app-password-here",
//   "rules": [
//     {
//       "id": "rule-1",
//       "label": "Beacon Advanced Friday nights",
//       "enabled": true,
//       "filters": {
//         "gym":        "Beacon",        // partial match, case-insensitive; "" = any
//         "date":       "",              // e.g. "06/27" or "Fri" — partial match
//         "time":       "7:00 pm",       // partial match
//         "court":      "",              // exact match after normalisation; "" = any
//         "difficulty": "Advanced"       // exact match; "" = any
//       }
//     }
//   ]
// }

function loadNotifConfig() {
  try {
    if (fs.existsSync(NOTIF_FILE)) {
      return JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[notif] Failed to load config:', e.message);
  }
  return { email: '', gmailUser: '', gmailPass: '', rules: [] };
}

function saveNotifConfig(cfg) {
  try {
    fs.writeFileSync(NOTIF_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[notif] Failed to save config:', e.message);
    return false;
  }
}

let notifConfig = loadNotifConfig();

// ── Email via Gmail SMTP (no deps — raw SMTP over TLS) ────────────────────────
// We use nodemailer-style approach but with Node's built-in tls module.
// Since we can't install nodemailer, we use the Gmail API via HTTPS instead.
// For simplicity we use a free SMTP relay: smtp.gmail.com via the net/tls module.
// Actually the zero-dep approach: use Gmail's REST API with an OAuth2 token —
// too complex. Instead we POST to a simple free relay or use Resend.
// We implement both: Gmail App Password (nodemailer when available) + Resend fallback.
async function sendEmail(subject, body, cfg) {
  if (!cfg.email) return;

  // Try nodemailer if available (user ran: npm install nodemailer)
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cfg.gmailUser, pass: cfg.gmailPass },
    });
    await transporter.sendMail({
      from   : cfg.gmailUser,
      to     : cfg.email,
      subject,
      text   : body,
    });
    console.log(`[notif] Email sent to ${cfg.email}`);
    return;
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') {
      console.error('[notif] Gmail error:', e.message);
      return;
    }
  }

  // Fallback: Resend API (free, no npm needed) if resendKey is configured
  if (cfg.resendKey) {
    const payload = JSON.stringify({
      from   : 'onboarding@resend.dev',
      to     : [cfg.email],
      subject,
      text   : body,
    });
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.resend.com',
        path    : '/emails',
        method  : 'POST',
        headers : {
          'Authorization': `Bearer ${cfg.resendKey}`,
          'Content-Type' : 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          console.log(`[notif] Resend response ${res.statusCode}: ${d.slice(0,80)}`);
          resolve();
        });
      });
      req.on('error', e => { console.error('[notif] Resend error:', e.message); resolve(); });
      req.write(payload); req.end();
    });
  }

  console.log('[notif] No email transport configured (set gmailUser/gmailPass or resendKey)');
}

// ── Rule matching ─────────────────────────────────────────────────────────────
function gameMatchesRule(game, rule) {
  if (!rule.enabled) return false;
  const f = rule.filters || {};

  // Accepts string (legacy) or array; empty = match anything; OR semantics within a field
  function matchesFilter(gameVal, filterVal, exact) {
    const vals = Array.isArray(filterVal) ? filterVal.filter(Boolean) : (filterVal ? [filterVal] : []);
    if (!vals.length) return true;
    const gv = (gameVal || '').toLowerCase();
    return exact
      ? vals.some(v => gv === v.toLowerCase())
      : vals.some(v => gv.includes(v.toLowerCase()));
  }

  if (!matchesFilter(game.gym,        f.gym,        false)) return false;
  if (!matchesFilter(game.date,       f.date,       false)) return false;
  if (!matchesFilter(game.time,       f.time,       false)) return false;
  if (!matchesFilter(game.difficulty, f.difficulty, true))  return false;
  if (!matchesFilter(game.court,      f.court,      true))  return false;
  return true;
}

async function processNotifications(newGames) {
  const cfg = notifConfig;
  if (!cfg.email || !cfg.rules || cfg.rules.length === 0) return;

  // For each rule, find newly available games that match
  for (const rule of cfg.rules) {
    if (!rule.enabled) continue;
    const matched = newGames.filter(g => gameMatchesRule(g, rule));
    if (matched.length === 0) continue;

    const lines = matched.map(g =>
      `• ${g.venueLabel} | ${g.date} | ${g.time} | ${g.difficulty}${g.court !== 'N/A' ? ' | ' + g.court : ''} | ${g.gym} | ${g.spots} spots`
    ).join('\n');

    const subject = `🏐 [${rule.label}] ${matched.length} spot${matched.length > 1 ? 's' : ''} just opened!`;
    const body = `Your alert "${rule.label}" matched ${matched.length} newly available session${matched.length > 1 ? 's' : ''}:\n\n${lines}\n\nRegister now: ${PAGE_URL}`;

    console.log(`[notif] Rule "${rule.label}" matched ${matched.length} games → emailing ${cfg.email}`);
    await sendEmail(subject, body, cfg);
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function postAjax(filterid, buttonid) {
  return new Promise((resolve, reject) => {
    const body = `action=my_open_play_contentbb&buttonid=${buttonid}&gametypeid=1&filterid=${filterid}`;
    const parsed = new URL(AJAX_URL);
    const req = https.request({
      hostname: parsed.hostname,
      path    : parsed.pathname,
      method  : 'POST',
      headers : {
        'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
        'Accept'          : 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language' : 'en-US,en;q=0.9',
        'Content-Type'    : 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length'  : Buffer.byteLength(body),
        'X-Requested-With': 'XMLHttpRequest',
        'Origin'          : 'https://www.nyurban.com',
        'Referer'         : PAGE_URL,
      },
      timeout: 20000,
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── Parsing ───────────────────────────────────────────────────────────────────
function htmlDecode(s) {
  return s
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<').replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).trim();
}
function stripTags(s) { return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

function expandLevel(s) {
  return s
    .replace(/\bBeg\.?\/Int\.?\b/gi,  'Beginner/Intermediate')
    .replace(/\bInt\.?\/Adv\.?\b/gi,  'Intermediate/Advanced')
    .replace(/\bAdv\.?\/Int\.?\b/gi,  'Advanced/Intermediate')
    .replace(/\bAdv\.?\b/gi,          'Advanced')
    .replace(/\bInt\.?\b/gi,          'Intermediate')
    .replace(/\bBeg\.?\b/gi,          'Beginner');
}

function parseTable(html, venue) {
  const games = [];
  if (/NO OPEN SESSION/i.test(html)) return [];

  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const row = trMatch[1];
    if (/<th/i.test(row)) continue;

    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(row)) !== null) {
      cells.push(htmlDecode(stripTags(tdMatch[1])));
    }
    if (cells.length < 4) continue;

    let dateIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      if (/\b(mon|tue|wed|thu|fri|sat|sun)\s+\d{1,2}\/\d{1,2}/i.test(cells[i]) ||
          /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(cells[i])) {
        dateIdx = i; break;
      }
    }
    if (dateIdx === -1) continue;

    const date     = cells[dateIdx]     || '';
    const gym      = cells[dateIdx + 1] || '';
    const level    = cells[dateIdx + 2] || '';
    const time     = cells[dateIdx + 3] || '';
    const fee      = cells[dateIdx + 4] || '';
    const spotsRaw = cells[dateIdx + 5] || cells[cells.length - 1] || '';

    const spotsNum = parseInt(spotsRaw, 10);
    const isFull   = /sold\s*out/i.test(spotsRaw) ||
                     spotsRaw.trim() === '0' ||
                     (!isNaN(spotsNum) && spotsNum === 0);
    const available = !isFull && spotsRaw.trim() !== '';

    const expandedLevel = expandLevel(level);
    let difficulty = expandedLevel;
    let court      = 'N/A';
    const dashIdx = expandedLevel.indexOf(' - ');
    if (dashIdx !== -1) {
      difficulty = expandedLevel.slice(0, dashIdx).trim();
      const courtRaw = expandedLevel.slice(dashIdx + 3).trim();
      court = /small\s*ct/i.test(courtRaw) ? 'Small Ct' : (courtRaw || 'N/A');
    } else {
      const courtMatch = expandedLevel.match(/\b(Court\s*\d+|Small\s*Ct\.?)\b/i);
      if (courtMatch) {
        court = /small/i.test(courtMatch[1]) ? 'Small Ct' : courtMatch[1];
        difficulty = expandedLevel.replace(courtMatch[1], '').replace(/[-–,]/g, '').trim() || expandedLevel;
      }
    }
    difficulty = difficulty.replace(/^[^a-zA-Z]+/, '').replace(/[^a-zA-Z)]+$/, '').trim();
    difficulty = difficulty.charAt(0).toUpperCase() + difficulty.slice(1);

    const id = `${venue.id}::${date}::${level}`.replace(/\s+/g, '-').toLowerCase();

    games.push({
      id, venueId: venue.id, venueLabel: venue.label,
      date, gym, level, difficulty, court, time, fee,
      spots: spotsRaw, available, link: PAGE_URL,
    });
  }
  return games;
}

// ── Scrape ────────────────────────────────────────────────────────────────────
async function scrapeVenue(venue) {
  const { status, body } = await postAjax(venue.filterId, venue.buttonId);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (body === '0' || body === '' || body === 'false') throw new Error('Empty response');
  return parseTable(body, venue);
}

async function scrapeAll() {
  console.log(`\n[${new Date().toISOString()}] Scraping all venues…`);
  const results = [];
  const errors  = {};

  for (const venue of VENUES) {
    try {
      const games = await scrapeVenue(venue);
      console.log(`  ✓ ${venue.label}: ${games.length} sessions`);
      results.push(...games);
    } catch (err) {
      console.error(`  ✗ ${venue.label}: ${err.message}`);
      errors[venue.id] = err.message;
    }
  }

  const newlyAvailable = results.filter(g => g.available && !previousAvailableIds.has(g.id));
  previousAvailableIds = new Set(results.filter(g => g.available).map(g => g.id));

  allGames     = results;
  lastScrape   = new Date();
  scrapeErrors = errors;

  const open = results.filter(g => g.available).length;
  console.log(`  → Total: ${results.length} sessions, ${open} available\n`);

  broadcast({ type: 'update', games: results, timestamp: lastScrape, errors });
  if (newlyAvailable.length > 0) {
    broadcast({ type: 'new_available', games: newlyAvailable, timestamp: lastScrape });
    await processNotifications(newlyAvailable);
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  subscribers = subscribers.filter(res => {
    try { res.write(payload); return true; } catch (_) { return false; }
  });
}

let pollTimer = null;
function startPolling(ms = 5 * 60 * 1000) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(scrapeAll, ms);
  console.log(`Polling every ${ms / 1000}s`);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE' });
    return res.end();
  }

  if (pathname === '/api/games')  return sendJSON(res, 200, { games: allGames, lastScrape, errors: scrapeErrors });
  if (pathname === '/api/venues') return sendJSON(res, 200, VENUES);
  if (pathname === '/api/status') return sendJSON(res, 200, {
    lastScrape, total: allGames.length, available: allGames.filter(g => g.available).length,
    errors: scrapeErrors,
    venues: VENUES.map(v => ({
      ...v,
      count    : allGames.filter(g => g.venueId === v.id).length,
      available: allGames.filter(g => g.venueId === v.id && g.available).length,
      error    : scrapeErrors[v.id] || null,
    })),
  });

  if (pathname === '/api/refresh' && req.method === 'POST') {
    scrapeAll().catch(() => {});
    return sendJSON(res, 202, { message: 'Scraping all venues…' });
  }

  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', games: allGames, lastScrape, errors: scrapeErrors, timestamp: new Date() })}\n\n`);
    subscribers.push(res);
    req.on('close', () => { subscribers = subscribers.filter(s => s !== res); });
    return;
  }

  // ── Notification config API ────────────────────────────────────────────────

  // GET /api/notifications — return current config (mask password)
  if (pathname === '/api/notifications' && req.method === 'GET') {
    const safe = { ...notifConfig, gmailPass: notifConfig.gmailPass ? '••••••••' : '', resendKey: notifConfig.resendKey ? '••••••••' : '' };
    return sendJSON(res, 200, safe);
  }

  // PUT /api/notifications — save email settings
  if (pathname === '/api/notifications' && req.method === 'PUT') {
    try {
      const body = JSON.parse(await readBody(req));
      // Only update credential fields if they weren't masked
      if (body.gmailPass && body.gmailPass !== '••••••••') notifConfig.gmailPass = body.gmailPass;
      if (body.resendKey && body.resendKey !== '••••••••') notifConfig.resendKey = body.resendKey;
      notifConfig.email     = body.email     || notifConfig.email;
      notifConfig.gmailUser = body.gmailUser || notifConfig.gmailUser;
      saveNotifConfig(notifConfig);
      return sendJSON(res, 200, { ok: true });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // GET /api/notifications/rules — list rules
  if (pathname === '/api/notifications/rules' && req.method === 'GET') {
    return sendJSON(res, 200, notifConfig.rules || []);
  }

  // POST /api/notifications/rules — add a rule
  if (pathname === '/api/notifications/rules' && req.method === 'POST') {
    try {
      const rule = JSON.parse(await readBody(req));
      rule.id = `rule-${Date.now()}`;
      if (!rule.label) rule.label = 'Alert ' + (notifConfig.rules.length + 1);
      if (rule.enabled === undefined) rule.enabled = true;
      if (!rule.filters) rule.filters = {};
      notifConfig.rules.push(rule);
      saveNotifConfig(notifConfig);
      return sendJSON(res, 201, rule);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // PUT /api/notifications/rules/:id — update a rule
  const ruleUpdateMatch = pathname.match(/^\/api\/notifications\/rules\/(.+)$/) ;
  if (ruleUpdateMatch && req.method === 'PUT') {
    try {
      const id   = ruleUpdateMatch[1];
      const data = JSON.parse(await readBody(req));
      const idx  = notifConfig.rules.findIndex(r => r.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Rule not found' });
      notifConfig.rules[idx] = { ...notifConfig.rules[idx], ...data, id };
      saveNotifConfig(notifConfig);
      return sendJSON(res, 200, notifConfig.rules[idx]);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // DELETE /api/notifications/rules/:id
  const ruleDeleteMatch = pathname.match(/^\/api\/notifications\/rules\/(.+)$/);
  if (ruleDeleteMatch && req.method === 'DELETE') {
    const id  = ruleDeleteMatch[1];
    const idx = notifConfig.rules.findIndex(r => r.id === id);
    if (idx === -1) return sendJSON(res, 404, { error: 'Rule not found' });
    notifConfig.rules.splice(idx, 1);
    saveNotifConfig(notifConfig);
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/notifications/test — send a test email
  if (pathname === '/api/notifications/test' && req.method === 'POST') {
    if (!notifConfig.email) return sendJSON(res, 400, { error: 'No email configured' });
    sendEmail(
      '🏐 NYUrban Tracker — Test Notification',
      `This is a test email from your NYUrban Volleyball Tracker.\n\nYour notification settings are working correctly!\n\nTracker URL: http://localhost:${PORT}`,
      notifConfig
    ).catch(e => console.error('[notif] Test email error:', e.message));
    return sendJSON(res, 200, { ok: true, message: `Test email sent to ${notifConfig.email}` });
  }

  if (pathname === '/' || pathname === '/index.html') {
    const p = path.join(__dirname, 'index.html');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return fs.createReadStream(p).pipe(res);
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🏐 Volleyball Ticket Tracker — All Venues`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Venues: ${VENUES.map(v => v.label).join(' | ')}\n`);
  await scrapeAll();
  startPolling(5 * 60 * 1000);
});

module.exports = { parseTable };
