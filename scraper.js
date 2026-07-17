#!/usr/bin/env node
/**
 * NYUrban Volleyball Tracker — GitHub Actions scraper
 *
 * Usage: node scraper.js
 * Scrapes all venues, upserts game data to Supabase, sends email alerts via
 * Brevo for newly-available spots matching per-user rules stored in Supabase.
 * Triggered by Cloudflare Worker cron (every 5 min) via workflow_dispatch. Zero npm dependencies.
 */

const https = require('https');

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
  return matchesFilter(game.venueLabel, f.venue, true)
      && matchesFilter(game.gym,         f.gym,   false)
      && matchesFilter(game.date,        f.date,  false)
      && matchesFilter(game.time,        f.time,  false)
      && matchesFilter(game.difficulty,  f.difficulty, true)
      && matchesFilter(game.court,       f.court,      true);
}

// ── Email via Brevo ────────────────────────────────────────────────────────────
function sendEmail(subject, body, to, brevoKey, brevoSender) {
  return new Promise((resolve) => {
    if (!brevoKey || !to || !brevoSender) { console.log('[email] BREVO_KEY, BREVO_SENDER, or recipient not set — skipping'); resolve(); return; }
    const payload = JSON.stringify({
      sender    : { email: brevoSender, name: 'NYUrban Alerts' },
      to        : [{ email: to }],
      subject,
      textContent: body,
    });
    const req = https.request({
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { console.log(`[email] Brevo ${res.statusCode}: ${d.slice(0, 80)}`); resolve(); });
    });
    req.on('error', e => { console.error('[email] Brevo error:', e.message); resolve(); });
    req.write(payload); req.end();
  });
}

// ── Supabase REST helper (zero-dep, service-role key) ─────────────────────────
function supabaseRequest(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url     = new URL(process.env.SUPABASE_URL);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'apikey'       : process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type' : 'application/json',
      ...extraHeaders,
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({
      hostname: url.hostname,
      path    : '/rest/v1' + path,
      method,
      headers,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: d ? JSON.parse(d) : null }); }
        catch (_) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Venue discovery ────────────────────────────────────────────────────────────
async function discoverVenues() {
  const { status, body } = await new Promise((resolve, reject) => {
    const req = https.get(PAGE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' },
      timeout: 20000,
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
  if (status !== 200) throw new Error(`Main page HTTP ${status}`);

  // Match onclick="SwitchMenu(this,1,FILTERID,...)" followed by label text
  const re = /onclick="SwitchMenu\([^,]+,\s*1,\s*(\d+),[^"]*\)"[^>]*>\s*([^<\n]+?)\s*</gi;
  const venues = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const filterId = Number(m[1]);
    const label    = htmlDecode(m[2]).replace(/\.$/, '').trim();
    const id       = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
    venues.push({ id, label, filterId, buttonId: venues.length + 1 });
  }
  return venues;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const brevoKey    = process.env.BREVO_KEY    || '';
  const brevoSender = process.env.BREVO_SENDER || '';
  const alertEmail  = process.env.ALERT_EMAIL  || '';

  // Test-email mode: send a delivery check and exit without scraping
  if (process.argv.includes('--test-email') || process.env.TEST_EMAIL === 'true') {
    console.log('[test-email] Sending test email…');
    await sendEmail(
      '🏐 NYUrban Alert — test email',
      `This is a test from the NYUrban Volleyball Tracker.\n\nIf you received this, email delivery is working correctly.\n\nTracker: ${PAGE_URL}`,
      alertEmail,
      brevoKey,
      brevoSender
    );
    console.log('[test-email] Done.');
    return;
  }

  // Load previous game state to detect newly-available spots
  const { data: prevData } = await supabaseRequest('GET', '/scrape_results?id=eq.1&select=games,catalog');
  const prevGames  = (prevData && prevData[0] && prevData[0].games) || [];
  const prevAvailIds = new Set(prevGames.filter(g => g.available).map(g => g.id));

  // Load alert rules
  const { data: rulesData } = await supabaseRequest('GET', '/alert_rules?enabled=eq.true&select=*');
  const rules = rulesData || [];

  // Discover venues dynamically; fall back to hardcoded list if page parse fails
  let venues = VENUES;
  try {
    const discovered = await discoverVenues();
    if (discovered.length > 0) {
      const knownFilterIds = new Set(VENUES.map(v => v.filterId));
      const newVenues = discovered.filter(v => !knownFilterIds.has(v.filterId));
      venues = [...VENUES, ...newVenues];
      if (newVenues.length) console.log(`  🆕 Discovered ${newVenues.length} new venue(s): ${newVenues.map(v => v.label).join(', ')}`);
    }
  } catch (e) {
    console.warn(`  ⚠️  Venue discovery failed (${e.message}), using hardcoded list`);
  }

  // Scrape all venues
  console.log(`[${new Date().toISOString()}] Scraping all venues…`);
  const allGames = [], errors = {};
  for (const venue of venues) {
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

  // Detect newly-available sessions and send per-user alerts
  const newlyAvail = allGames.filter(g => g.available && !prevAvailIds.has(g.id));
  if (newlyAvail.length > 0) {
    console.log(`  🎉 ${newlyAvail.length} newly available!`);
    for (const rule of rules.filter(r => r.enabled)) {
      const matched = newlyAvail.filter(g => gameMatchesRule(g, rule));
      if (matched.length === 0) continue;
      const lines = matched.map(g =>
        `• ${g.venueLabel} | ${g.date} | ${g.time} | ${g.difficulty}${g.court !== 'N/A' ? ' | ' + g.court : ''} | ${g.spots} spot${g.spots === '1' ? '' : 's'} available`
      ).join('\n');
      const g0      = matched[0];
      const g0court = g0.court !== 'N/A' ? ` | ${g0.court}` : '';
      const sessionSummary = matched.length === 1
        ? `${g0.venueLabel} | ${g0.date} | ${g0.time} | ${g0.difficulty}${g0court}`
        : `${matched.length} sessions — ${g0.venueLabel}${matched.length > 1 ? ` + ${matched.length - 1} more` : ''}`;
      const subject    = `🏐 ${matched.length} spot${matched.length > 1 ? 's' : ''} just opened — ${sessionSummary}`;
      const disableUrl = `https://christopherkwok.github.io/vb-tix_app/?disable_token=${rule.disable_token}`;
      const body       = `Alert rule: "${rule.label}"\n\nNewly available session${matched.length > 1 ? 's' : ''}:\n\n${lines}\n\nBook now: ${PAGE_URL}\n\n---\nTo disable this alert: ${disableUrl}`;
      const to = rule.user_email;
      console.log(`  📧 Emailing "${rule.label}" → ${to} (${matched.length} match(es))`);
      await sendEmail(subject, body, to, brevoKey, brevoSender);
    }
  }

  // Accumulate historical combo catalog (venue + time + difficulty + court fingerprints)
  const prevCombos   = (prevData && prevData[0] && prevData[0].catalog && prevData[0].catalog.combos) || [];
  const existingKeys = new Set(prevCombos.map(c => `${c.venue}|${c.time}|${c.difficulty}|${c.court ?? ''}`));
  const newCombos    = allGames
    .map(g => ({
      venue:      g.venueLabel,
      time:       g.time,
      difficulty: g.difficulty,
      court:      (g.court && g.court !== 'N/A') ? g.court : null,
    }))
    .filter(c => c.venue && c.time && c.difficulty)
    .filter(c => !existingKeys.has(`${c.venue}|${c.time}|${c.difficulty}|${c.court ?? ''}`));
  const catalog = { combos: [...prevCombos, ...newCombos] };
  if (newCombos.length) console.log(`  📚 Catalog: +${newCombos.length} new combo(s) → ${catalog.combos.length} total`);

  // Write updated data
  const { status, data: writeResult } = await supabaseRequest(
    'POST', '/scrape_results',
    { id: 1, games: allGames, last_scrape: new Date().toISOString(), errors, catalog },
    { 'Prefer': 'resolution=merge-duplicates' }
  );
  if (status < 200 || status >= 300) {
    throw new Error(`Supabase write failed HTTP ${status}: ${JSON.stringify(writeResult)}`);
  }
  console.log(`  ✓ Supabase scrape_results updated (HTTP ${status})`);
}

main().catch(e => { console.error(e); process.exit(1); });
