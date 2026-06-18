#!/usr/bin/env node
/**
 * NYUrban Volleyball Ticket Tracker — All venues
 * Pure Node.js, zero dependencies
 *
 * AJAX call (from openplay.js):
 *   POST /wp-admin/admin-ajax.php
 *   action=my_open_play_contentbb&buttonid=1&gametypeid=1&filterid=FILTERID
 */

const http = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
const url   = require('url');

const PORT     = 3333;
const AJAX_URL = 'https://www.nyurban.com/wp-admin/admin-ajax.php';
const PAGE_URL = 'https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1';

// buttonid=1 works for all venues; filterid distinguishes them
// (confirmed from SwitchMenu calls on the main page)
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
let previousIds  = new Set();

// ── HTTP ──────────────────────────────────────────────────────────────────────
function postAjax(filterid, buttonid) {
  return new Promise((resolve, reject) => {
    // Exact format from openplay.js:
    // "action=my_open_play_contentbb&buttonid="+obj+"&gametypeid="+gametypeid+"&filterid="+filterid
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

function parseTable(html, venue) {
  const games = [];

  // Check for "no sessions" message
  if (/NO OPEN SESSION/i.test(html)) {
    return [];
  }

  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch, rowIdx = 0;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const row = trMatch[1];
    if (/<th/i.test(row)) continue; // skip header

    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRe.exec(row)) !== null) {
      cells.push(htmlDecode(stripTags(tdMatch[1])));
    }

    if (cells.length < 4) continue;

    // Find date column — NYUrban format: "Fri 06/27" or "06/27/25"
    let dateIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      if (/\b(mon|tue|wed|thu|fri|sat|sun)\s+\d{1,2}\/\d{1,2}/i.test(cells[i]) ||
          /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(cells[i])) {
        dateIdx = i; break;
      }
    }
    if (dateIdx === -1) continue;

    // Columns: [select checkbox] Date | Gym | Level | Time | Fee | Available
    const date     = cells[dateIdx]     || '';
    const gym      = cells[dateIdx + 1] || '';
    const level    = cells[dateIdx + 2] || '';
    const time     = cells[dateIdx + 3] || '';
    const fee      = cells[dateIdx + 4] || '';
    const spotsRaw = cells[dateIdx + 5] || cells[cells.length - 1] || '';

    // Available column: a number > 0 = open; "Sold Out" or 0 = full
    const spotsNum = parseInt(spotsRaw, 10);
    const isFull   = /sold\s*out/i.test(spotsRaw) ||
                     spotsRaw.trim() === '0' ||
                     (!isNaN(spotsNum) && spotsNum === 0);
    const available = !isFull && spotsRaw.trim() !== '';

    // Parse difficulty and court out of the level field.
    // Examples from the site:
    //   "Intermediate - Court 1"      → difficulty="Intermediate",          court="Court 1"
    //   "Intermediate - Small Ct"     → difficulty="Intermediate",          court="Small Ct"
    //   "Advanced"                    → difficulty="Advanced",               court="N/A"
    //   "Beginner/Intermediate"       → difficulty="Beginner/Intermediate",  court="N/A"
    //   "Beg./Int. - Small Ct"        → difficulty="Beginner/Intermediate",  court="Small Ct"
    //   "Beg. - Court 1"              → difficulty="Beginner",               court="Court 1"
    //   "Int. - Court 2"              → difficulty="Intermediate",           court="Court 2"
    //   "Adv. - Small Ct"             → difficulty="Advanced",               court="Small Ct"

    // Step 1: expand abbreviated level names before any splitting.
    // Combined patterns (Beg./Int.) MUST come before individual ones (Beg.)
    // to avoid partial substitution producing "Beginner/Int." etc.
    function expandLevel(s) {
      return s
        // Combined first
        .replace(/\bBeg\.?\/Int\.?\b/gi,  'Beginner/Intermediate')
        .replace(/\bInt\.?\/Adv\.?\b/gi,  'Intermediate/Advanced')
        .replace(/\bAdv\.?\/Int\.?\b/gi,  'Advanced/Intermediate')
        // Individual after
        .replace(/\bAdv\.?\b/gi,            'Advanced')
        .replace(/\bInt\.?\b/gi,            'Intermediate')
        .replace(/\bBeg\.?\b/gi,            'Beginner');
    }
    const expandedLevel = expandLevel(level);

    let difficulty = expandedLevel;
    let court      = 'N/A';
    const dashIdx = expandedLevel.indexOf(' - ');
    if (dashIdx !== -1) {
      difficulty = expandedLevel.slice(0, dashIdx).trim();
      const courtRaw = expandedLevel.slice(dashIdx + 3).trim();
      if (/small\s*ct/i.test(courtRaw)) {
        court = 'Small Ct';
      } else {
        court = courtRaw || 'N/A';
      }
    } else {
      const courtMatch = expandedLevel.match(/\b(Court\s*\d+|Small\s*Ct\.?)\b/i);
      if (courtMatch) {
        court = /small/i.test(courtMatch[1]) ? 'Small Ct' : courtMatch[1];
        difficulty = expandedLevel.replace(courtMatch[1], '').replace(/[-–,]/g, '').trim() || expandedLevel;
      }
    }

    // Strip leading/trailing punctuation but preserve "/" between words (e.g. Beginner/Intermediate)
    difficulty = difficulty.replace(/^[^a-zA-Z]+/, '').replace(/[^a-zA-Z)]+$/, '').trim();

    // Normalise capitalisation
    difficulty = difficulty.charAt(0).toUpperCase() + difficulty.slice(1);

    const id = `${venue.id}::${date}::${level}`.replace(/\s+/g, '-').toLowerCase();

    games.push({
      id,
      venueId   : venue.id,
      venueLabel: venue.label,
      date, gym, level, difficulty, court, time, fee,
      spots    : spotsRaw,
      available,
      link     : PAGE_URL,
      filterId : venue.filterId,
      buttonId : venue.buttonId,
    });
    rowIdx++;
  }

  return games;
}

// ── Scrape one venue ──────────────────────────────────────────────────────────
async function scrapeVenue(venue) {
  const { status, body } = await postAjax(venue.filterId, venue.buttonId);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (body === '0' || body === '' || body === 'false') throw new Error('Empty response from server');
  return parseTable(body, venue);
}

// ── Scrape all venues ─────────────────────────────────────────────────────────
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

  const newlyAvailable = results.filter(g => g.available && !previousIds.has(g.id));
  results.forEach(g => previousIds.add(g.id));

  allGames     = results;
  lastScrape   = new Date();
  scrapeErrors = errors;

  const open = results.filter(g => g.available).length;
  console.log(`  → Total: ${results.length} sessions, ${open} available\n`);

  broadcast({ type: 'update', games: results, timestamp: lastScrape, errors });
  if (newlyAvailable.length > 0) {
    broadcast({ type: 'new_available', games: newlyAvailable, timestamp: lastScrape });
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

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST' });
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

  if (pathname === '/' || pathname === '/index.html') {
    const p = path.join(__dirname, 'index.html');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return fs.createReadStream(p).pipe(res);
    }
  }

  // Relay page: opens nyurban and auto-clicks the right venue tab
  const goMatch = pathname.match(/^\/go\/(\d+)$/);
  if (goMatch) {
    const buttonId = parseInt(goMatch[1], 10);
    const venue    = VENUES.find(v => v.buttonId === buttonId) || VENUES[0];
    const relay    = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Opening ${venue.label}…</title>
<style>
  body { font-family: system-ui, sans-serif; display:flex; align-items:center; justify-content:center;
         min-height:100vh; margin:0; background:#1A3A5C; color:#fff; flex-direction:column; gap:1rem; }
  p { opacity:.7; font-size:.9rem; }
  a { color:#C8A84B; }
</style>
</head>
<body>
<div style="font-size:2rem">🏐</div>
<div style="font-size:1.1rem;font-weight:600">Opening ${venue.label}…</div>
<p>If the page doesn't open automatically, <a href="https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1" target="_blank">click here</a>.</p>
<script>
  // Open the main nyurban page, then trigger the correct tab via postMessage / opener
  var w = window.open('https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1', '_blank');
  // After the page loads, call SwitchMenu for the correct tab
  var buttonId = ${buttonId};
  var filterId = ${venue.filterId};
  var attempts = 0;
  var timer = setInterval(function() {
    attempts++;
    try {
      if (w && w.SwitchMenu) {
        w.SwitchMenu(buttonId, '1', filterId, 'https://www.nyurban.com/wp-admin/admin-ajax.php', 'active');
        clearInterval(timer);
      }
    } catch(e) {}
    if (attempts > 40) {
      clearInterval(timer);
      // Cross-origin blocks us — redirect instead so user at least gets the page
      window.location.href = 'https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1';
    }
  }, 250);
<\/script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(relay);
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
