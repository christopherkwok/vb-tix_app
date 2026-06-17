/**
 * Run: node debug-fetch3.js
 * Tests the real AJAX action with the correct params for each venue.
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

function get(url) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const req = https.request({
      hostname: p.hostname, path: p.pathname + p.search, method: 'GET',
      headers: HEADERS, timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : `https://${p.hostname}${res.headers.location}`;
        return get(loc).then(resolve).catch(reject);
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

function post(url, bodyStr) {
  return new Promise((resolve, reject) => {
    const p = new URL(url);
    const req = https.request({
      hostname: p.hostname, path: p.pathname, method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(bodyStr),
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Origin': 'https://www.nyurban.com',
      },
      timeout: 15000,
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr); req.end();
  });
}

const AJAX = 'https://www.nyurban.com/wp-admin/admin-ajax.php';

// From the JS:  action=my_open_play_contentbb&buttonid=OBJ&gametypeid=GAMETYPEID&filterid=FILTERID
// SwitchMenu(obj, gametypeid, filterid, ajaxUrl, selclass)
// We need the SwitchMenu calls from the main page to know buttonid per venue.

async function run() {
  // Step 1: get main page and extract all SwitchMenu calls
  console.log('=== Fetching main page to find SwitchMenu calls ===');
  const main = await get('https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1');
  const calls = main.body.match(/SwitchMenu\([^)]+\)/g) || [];
  console.log('SwitchMenu calls found:', calls);

  // Step 2: call with known action for each venue
  // Format: action=my_open_play_contentbb&buttonid=BUTTONID&gametypeid=1&filterid=FILTERID
  const VENUES = [
    { id: 'laguardia',    label: 'Laguardia/Fri',  filterId: 35 },
    { id: 'beacon',       label: 'Beacon/Fri',      filterId: 34 },
    { id: 'brandeis-fri', label: 'Brandeis/Fri',    filterId: 6  },
    { id: 'brandeis-sun', label: 'Brandeis/Sun',    filterId: 18 },
    { id: 'clinics',      label: 'Clinics',         filterId: 32 },
  ];

  // Try buttonid 1–5 for each venue
  console.log('\n=== Testing my_open_play_contentbb for each venue ===');
  for (const venue of VENUES) {
    for (const buttonid of [1, 2, 3, 4, 5]) {
      const bodyStr = `action=my_open_play_contentbb&buttonid=${buttonid}&gametypeid=1&filterid=${venue.filterId}`;
      const r = await post(AJAX, bodyStr);
      const hasTable = r.body.includes('<td');
      const isEmpty = r.body === '0' || r.body === '' || r.body === '-1' || r.body === 'false';
      const isNoSession = r.body.includes('NO OPEN SESSION');
      if (!isEmpty) {
        console.log(`${venue.label} buttonid=${buttonid}: status=${r.status} len=${r.body.length} hasTable=${hasTable} noSession=${isNoSession}`);
        if (hasTable || isNoSession) {
          fs.writeFileSync(path.join(OUT, `ajax-${venue.id}-btn${buttonid}.html`), r.body);
          console.log(`  → Saved! Preview: ${r.body.slice(0, 200)}`);
          break; // found the right buttonid
        }
      }
    }
  }

  console.log('\nDone. Check debug-output/ for saved responses.');
}

run().catch(e => console.error('Fatal:', e));
