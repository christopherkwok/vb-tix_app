/**
 * Run this ONCE on your machine: node debug-fetch.js
 * It saves the raw HTML from each venue to debug-output/ 
 * so we can see exactly what the site returns.
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const OUT_DIR  = path.join(__dirname, 'debug-output');
const BASE_URL = 'https://www.nyurban.com/?page_id=400&gametypeid=1&filter_id=';
const AJAX_URL = 'https://www.nyurban.com/wp-admin/admin-ajax.php';

const VENUES = [
  { id: 'laguardia',    label: 'Laguardia / Fri',  filterId: 35 },
  { id: 'beacon',       label: 'Beacon / Fri',      filterId: 34 },
  { id: 'brandeis-fri', label: 'Brandeis / Fri',    filterId: 6  },
  { id: 'brandeis-sun', label: 'Brandeis / Sun',    filterId: 18 },
  { id: 'clinics',      label: 'Clinics',           filterId: 32 },
];

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
  'Accept'         : 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer'        : 'https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1',
};

function get(url) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const req = https.request({ hostname: p.hostname, path: p.pathname + p.search, method: 'GET', headers: HEADERS, timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location.startsWith('http') ? res.headers.location : `https://${p.hostname}${res.headers.location}`).then(resolve).catch(reject);
      }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function post(url, params, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const p = new URL(url);
    const req = https.request({
      hostname: p.hostname, path: p.pathname, method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01', ...extraHeaders },
      timeout: 15000,
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

function save(filename, content) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, filename), content, 'utf8');
  console.log(`  Saved: debug-output/${filename} (${content.length} bytes)`);
}

async function run() {
  console.log('🔍 Debug fetch — saving raw HTML from each venue\n');

  // 1. Full main page (includes SwitchMenu JS + Laguardia table)
  console.log('Fetching main page…');
  const main = await get('https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1');
  save('main-page.html', main.body);

  // Extract SwitchMenu & ajax info from main page
  const switchCalls = main.body.match(/SwitchMenu[^;)'"]{0,200}/g) || [];
  const ajaxUrl     = main.body.match(/ajaxurl\s*=\s*['"]([^'"]+)['"]/)?.[1] || '';
  const actionNames = main.body.match(/action['":\s]+([a-z_]+)/gi) || [];
  console.log('\n  SwitchMenu calls:', switchCalls);
  console.log('  ajaxurl:', ajaxUrl);
  console.log('  action references:', actionNames.slice(0, 10));

  // 2. GET each venue page
  for (const venue of VENUES) {
    console.log(`\nFetching GET ${venue.label} (filter_id=${venue.filterId})…`);
    const r = await get(`${BASE_URL}${venue.filterId}`);
    save(`get-${venue.id}.html`, r.body);

    // Count table rows
    const rows = (r.body.match(/<tr/g) || []).length;
    const tables = (r.body.match(/<table/g) || []).length;
    console.log(`  Status: ${r.status} | Tables: ${tables} | Rows: ${rows}`);
  }

  // 3. Try AJAX POST with several action names for one venue (beacon)
  const testActions = [
    'open_play', 'get_open_play_list', 'switch_open_play',
    'openplay', 'get_games', 'load_open_play', 'open_play_tab',
    'get_open_play', 'filter_open_play', 'open_play_filter',
  ];

  const testAjaxUrl = ajaxUrl || AJAX_URL;
  console.log(`\nTesting AJAX actions against: ${testAjaxUrl}`);

  for (const action of testActions) {
    const r = await post(testAjaxUrl, { action, filter_id: 34, game_type: 1, tab: 2 });
    const hasTable = r.body.includes('<td') || r.body.includes('<tr');
    const hasData  = r.body.length > 50 && r.body !== '0' && r.body !== '-1' && r.body !== 'false';
    if (hasData) {
      console.log(`  action=${action}: status=${r.status} len=${r.body.length} hasTable=${hasTable}`);
      console.log(`    Preview: ${r.body.slice(0, 120)}`);
      save(`ajax-${action}-beacon.html`, r.body);
    } else {
      console.log(`  action=${action}: status=${r.status} → "${r.body.slice(0,30)}" (empty)`);
    }
  }

  console.log('\n✅ Done — share the debug-output/ folder contents to diagnose the issue.');
}

run().catch(e => console.error('Fatal:', e.message));
