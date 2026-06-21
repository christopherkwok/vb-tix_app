#!/usr/bin/env node
/**
 * NYUrban Volleyball Tracker — GitHub Actions scraper
 *
 * Usage: node scraper.js
 * Writes docs/games.json, sends email alerts via Resend for newly-available spots.
 * Reads alert rules from config/alerts.json.
 * Designed to run on a cron schedule via GitHub Actions (zero dependencies).
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const AJAX_URL = 'https://www.nyurban.com/wp-admin/admin-ajax.php';
const PAGE_URL = 'https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1';

const VENUES = [
  { id: 'laguardia',    label: 'Laguardia / Fri',  filterId: 35, buttonId: 1 },
  { id: 'beacon',       label: 'Beacon / Fri',      filterId: 34, buttonId: 2 },
  { id: 'brandeis-fri', label: 'Brandeis / Fri',    filterId: 6,  buttonId: 3 },
  { id: 'brandeis-sun', label: 'Brandeis / Sun',    filterId: 18, buttonId: 4 },
  { id: 'clinics',      label: 'Clinics',           filterId: 32, buttonId: 5 },
];

// ── HTTP ───────────────────────────────────────────────────────────────────────
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

// ── Parsing ────────────────────────────────────────────────────────────────────
function htmlDecode(s) {
  return s
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<').replace(/&gt;/g,  '>')
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
    while ((tdMatch = tdRe.exec(row)) !== null) cells.push(htmlDecode(stripTags(tdMatch[1])));
    if (cells.length < 4) continue;

    let dateIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      if (/\b(mon|tue|wed|thu|fri|sat|sun)\s+\d{1,2}\/\d{1,2}/i.test(cells[i]) ||
          /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(cells[i])) { dateIdx = i; break; }
    }
    if (dateIdx === -1) continue;

    const date     = cells[dateIdx]     || '';
    const gym      = cells[dateIdx + 1] || '';
    const level    = cells[dateIdx + 2] || '';
    const time     = cells[dateIdx + 3] || '';
    const fee      = cells[dateIdx + 4] || '';
    const spotsRaw = cells[dateIdx + 5] || cells[cells.length - 1] || '';

    const spotsNum  = parseInt(spotsRaw, 10);
    const isFull    = /sold\s*out/i.test(spotsRaw) || spotsRaw.trim() === '0' || (!isNaN(spotsNum) && spotsNum === 0);
    const available = !isFull && spotsRaw.trim() !== '';

    const expandedLevel = expandLevel(level);
    let difficulty = expandedLevel, court = 'N/A';
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
    games.push({ id, venueId: venue.id, venueLabel: venue.label, date, gym, level, difficulty, court, time, fee, spots: spotsRaw, available, link: PAGE_URL });
  }
  return games;
}

// ── Rule matching ──────────────────────────────────────────────────────────────
function gameMatchesRule(game, rule) {
  if (!rule.enabled) return false;
  const f = rule.filters || {};
  function matchesFilter(gameVal, filterVal, exact) {
    const vals = Array.isArray(filterVal) ? filterVal.filter(Boolean) : (filterVal ? [filterVal] : []);
    if (!vals.length) return true;
    const gv = (gameVal || '').toLowerCase();
    return exact ? vals.some(v => gv === v.toLowerCase()) : vals.some(v => gv.includes(v.toLowerCase()));
  }
  return matchesFilter(game.gym, f.gym, false)
      && matchesFilter(game.date, f.date, false)
      && matchesFilter(game.time, f.time, false)
      && matchesFilter(game.difficulty, f.difficulty, true)
      && matchesFilter(game.court, f.court, true);
}

// ── Email via Resend ───────────────────────────────────────────────────────────
function sendEmail(subject, body, to, resendKey) {
  return new Promise((resolve) => {
    if (!resendKey || !to) { console.log('[email] RESEND_KEY or ALERT_EMAIL not set — skipping'); resolve(); return; }
    const payload = JSON.stringify({ from: 'onboarding@resend.dev', to: [to], subject, text: body });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { console.log(`[email] Resend ${res.statusCode}: ${d.slice(0, 80)}`); resolve(); });
    });
    req.on('error', e => { console.error('[email] Resend error:', e.message); resolve(); });
    req.write(payload); req.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const dataFile   = path.join(__dirname, 'docs', 'games.json');
  const rulesFile  = path.join(__dirname, 'config', 'alerts.json');
  const resendKey  = process.env.RESEND_KEY  || '';
  const alertEmail = process.env.ALERT_EMAIL || '';

  // Load previous game state to detect newly-available spots
  let prevData = { games: [] };
  try { if (fs.existsSync(dataFile)) prevData = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (_) {}
  const prevAvailIds = new Set((prevData.games || []).filter(g => g.available).map(g => g.id));

  // Load alert rules
  let rules = [];
  try { if (fs.existsSync(rulesFile)) ({ rules } = JSON.parse(fs.readFileSync(rulesFile, 'utf8'))); } catch (_) {}

  // Scrape all venues
  console.log(`[${new Date().toISOString()}] Scraping all venues…`);
  const allGames = [], errors = {};
  for (const venue of VENUES) {
    try {
      const { status, body } = await postAjax(venue.filterId, venue.buttonId);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      if (!body || body === '0' || body === 'false') throw new Error('Empty response');
      const games = parseTable(body, venue);
      allGames.push(...games);
      console.log(`  ✓ ${venue.label}: ${games.length} sessions`);
    } catch (e) {
      console.error(`  ✗ ${venue.label}: ${e.message}`);
      errors[venue.id] = e.message;
    }
  }

  const open = allGames.filter(g => g.available).length;
  console.log(`  → ${allGames.length} sessions, ${open} available`);

  // Detect newly-available sessions
  const newlyAvail = allGames.filter(g => g.available && !prevAvailIds.has(g.id));
  if (newlyAvail.length > 0) {
    console.log(`  🎉 ${newlyAvail.length} newly available!`);
    for (const rule of rules.filter(r => r.enabled)) {
      const matched = newlyAvail.filter(g => gameMatchesRule(g, rule));
      if (matched.length === 0) continue;
      const lines = matched.map(g =>
        `• ${g.venueLabel} | ${g.date} | ${g.time} | ${g.difficulty}${g.court !== 'N/A' ? ' | ' + g.court : ''} | ${g.gym} | ${g.spots} spots`
      ).join('\n');
      const subject = `🏐 [${rule.label}] ${matched.length} spot${matched.length > 1 ? 's' : ''} just opened!`;
      const body    = `Your alert "${rule.label}" matched ${matched.length} newly available session${matched.length > 1 ? 's' : ''}:\n\n${lines}\n\nRegister now: ${PAGE_URL}`;
      console.log(`  📧 Emailing "${rule.label}" → ${matched.length} match(es)`);
      await sendEmail(subject, body, alertEmail, resendKey);
    }
  }

  // Write updated data (docs/games.json is served by GitHub Pages)
  fs.mkdirSync(path.join(__dirname, 'docs'), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify({ games: allGames, lastScrape: new Date().toISOString(), errors }, null, 2), 'utf8');
  console.log(`  ✓ docs/games.json updated`);
}

main().catch(e => { console.error(e); process.exit(1); });
