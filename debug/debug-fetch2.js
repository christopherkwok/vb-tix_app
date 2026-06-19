/**
 * Run: node debug-fetch2.js
 * Fetches openplay.js and tests the AJAX call it makes.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'debug-output');
fs.mkdirSync(OUT, { recursive: true });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
  'Accept': '*/*',
  'Referer': 'https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1',
};

function get(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const req = https.request({
      hostname: p.hostname, path: p.pathname + p.search, method: 'GET',
      headers: { ...HEADERS, ...extraHeaders }, timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : `https://${p.hostname}${res.headers.location}`;
        return get(loc, extraHeaders).then(resolve).catch(reject);
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

function post(url, params) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const p = new URL(url);
    const req = https.request({
      hostname: p.hostname, path: p.pathname, method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
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

async function run() {
  // 1. Fetch openplay.js — this is the key file that makes the AJAX call
  console.log('=== Fetching openplay.js ===');
  const jsUrls = [
    'https://www.nyurban.com/wp-content/themes/twentyeleven/js/block/openplay.js',
    'https://www.nyurban.com/wp-content/themes/twentyeleven/js/openplay.js',
    'https://www.nyurban.com/wp-content/themes/twentyeleven/js/custom.js',
  ];
  for (const jsUrl of jsUrls) {
    try {
      const r = await get(jsUrl);
      console.log(`${jsUrl}: status=${r.status} len=${r.body.length}`);
      if (r.status === 200 && r.body.length > 100) {
        const fname = jsUrl.split('/').pop();
        fs.writeFileSync(path.join(OUT, fname), r.body);
        console.log(`  Saved: debug-output/${fname}`);
        console.log(`  Content:\n${r.body.slice(0, 2000)}`);
      }
    } catch(e) { console.log(`  Error: ${e.message}`); }
  }

  // 2. Try every plausible AJAX param combo for Beacon (filterId=34)
  console.log('\n=== Testing AJAX calls for Beacon (filter_id=34) ===');
  const AJAX = 'https://www.nyurban.com/wp-admin/admin-ajax.php';
  const combos = [
    { action: 'open_play',             filter_id: 34, GameTypeID: 1 },
    { action: 'open_play',             filter_id: 34, game_type_id: 1 },
    { action: 'open_play',             FilterID: 34,  GameTypeID: 1 },
    { action: 'get_open_play',         filter_id: 34, GameTypeID: 1 },
    { action: 'openplay',              filter_id: 34, GameTypeID: 1 },
    { action: 'open_play_list',        filter_id: 34, GameTypeID: 1 },
    { action: 'ny_open_play',          filter_id: 34, GameTypeID: 1 },
    { action: 'vb_open_play',          filter_id: 34, GameTypeID: 1 },
    { action: 'open_play',             filter_id: 34 },
    { action: 'open_play',             f_FilterID: 34, f_GameTypeID: 1 },
    { action: 'SwitchMenu',            filter_id: 34, GameTypeID: 1 },
    { action: 'switch_menu',           filter_id: 34, GameTypeID: 1 },
    { action: 'open_play',             tab_id: 34,    GameTypeID: 1 },
    { action: 'get_games',             filter_id: 34, GameTypeID: 1 },
    { action: 'get_open_play_games',   filter_id: 34, GameTypeID: 1 },
  ];

  for (const params of combos) {
    try {
      const r = await post(AJAX, params);
      const hasData = r.body.length > 10 && r.body !== '0' && r.body !== '-1' && r.body !== 'false' && r.body !== '';
      const hasTable = r.body.includes('<td') || r.body.includes('<tr');
      if (hasData) {
        console.log(`✓ action=${params.action} params=${JSON.stringify(params)}`);
        console.log(`  status=${r.status} len=${r.body.length} hasTable=${hasTable}`);
        console.log(`  body: ${r.body.slice(0, 300)}`);
        fs.writeFileSync(path.join(OUT, `ajax-${params.action}-${JSON.stringify(params).replace(/[^a-z0-9]/gi,'_').slice(0,40)}.html`), r.body);
      } else {
        console.log(`✗ action=${params.action} → "${r.body.slice(0,20)}" (empty/false)`);
      }
    } catch(e) { console.log(`✗ action=${params.action} → Error: ${e.message}`); }
  }
}

run().catch(e => console.error('Fatal:', e));
