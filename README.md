# 🏐 NYUrban Volleyball Ticket Tracker

A lightweight, **zero-dependency** Node.js app that scrapes [NYUrban's open play schedule](https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1) every 5 minutes and shows ticket availability in a live-updating UI.

---

## Features

- ✅ **All 5 venues** — Laguardia/Fri, Beacon/Fri, Brandeis/Fri, Brandeis/Sun, Clinics
- ✅ **Real-time UI** — Server-Sent Events (SSE) push updates instantly to the browser
- ✅ **Contextual filters** — Availability, Difficulty, Court, and Time dropdowns that only show options present in the current filtered view
- ✅ **Browser notifications** — opt-in alerts when new spots open
- ✅ **Zero dependencies** — pure Node.js built-ins only (`http`, `https`, `fs`, `url`)
- ✅ **Force refresh** — manual button for an instant re-scrape

---

## Requirements

- **Node.js v16+** — download from [nodejs.org](https://nodejs.org) (LTS version)
- No `npm install` needed

---

## Quick Start

```bash
# 1. Put server.js and index.html in the same folder
cd vb-tix-tracker

# 2. Start the server
node server.js

# 3. Open your browser
# http://localhost:3333
```

Keep the PowerShell/terminal window open — closing it stops the server.  
Press **Ctrl + C** to stop.

---

## How It Works

```
Browser (SSE) ←──── Node.js server (port 3333) ────→ nyurban.com
     ↓                        ↓
Live UI update        AJAX POST every 5 min
                      action=my_open_play_contentbb
                      Regex HTML parser (no libs)
```

### AJAX details

The site loads each venue tab via jQuery AJAX. The server replicates this call exactly:

```
POST https://www.nyurban.com/wp-admin/admin-ajax.php
action=my_open_play_contentbb&buttonid=1&gametypeid=1&filterid=FILTER_ID
```

| Venue | filterId |
|---|---|
| Laguardia / Fri | 35 |
| Beacon / Fri | 34 |
| Brandeis / Fri | 6 |
| Brandeis / Sun | 18 |
| Clinics | 32 |

### Column parsing

The HTML table columns are: `Select | Date | Gym | Level | Time | Fee | Available`

The **Level** column (e.g. `"Intermediate - Court 1"`, `"Advanced - Small Ct"`) is split into:
- `difficulty` — `"Intermediate"`, `"Advanced"`, `"Beginner"`, etc.
- `court` — `"Court 1"`, `"Court 2"`, `"Small Ct"`, or `"N/A"`

The **Available** column is a number (`3`, `0`) or `"Sold Out"`.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Serves the UI |
| GET | `/api/games` | All games as JSON |
| GET | `/api/venues` | Venue list |
| GET | `/api/status` | Server health + per-venue counts |
| GET | `/api/stream` | SSE stream (live updates) |
| POST | `/api/refresh` | Trigger an immediate scrape |

---

## Changing the Poll Interval

Edit the last line of `server.js`:

```js
startPolling(5 * 60 * 1000); // every 5 minutes — change as needed
```

---

## 📧 Email & 📱 Text Notifications (Free Options)

Browser notifications work out of the box (click "Enable Notifications" in the UI). For email or SMS alerts when new spots open, here are the best free options:

### Email — Gmail + Nodemailer (easiest, truly free)

Uses your own Gmail account as the sender. No paid service needed.

**Setup:**
1. Enable 2-Factor Authentication on your Google account
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) → create an App Password for "Mail"
3. Install Nodemailer: `npm install nodemailer`
4. Add to `server.js`:

```js
const nodemailer = require('nodemailer');

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'your.email@gmail.com',
    pass: 'your-16-char-app-password', // NOT your regular Gmail password
  },
});

async function sendEmailAlert(games) {
  const list = games.map(g =>
    `• ${g.venueLabel} — ${g.date} ${g.time} | ${g.difficulty} ${g.court !== 'N/A' ? '| ' + g.court : ''} | ${g.spots} spots`
  ).join('\n');

  await mailer.sendMail({
    from: 'your.email@gmail.com',
    to: 'your.email@gmail.com',   // send to yourself (or a list)
    subject: `🏐 ${games.length} NYUrban spot${games.length > 1 ? 's' : ''} just opened!`,
    text: `New volleyball spots are available:\n\n${list}\n\nRegister: https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1`,
  });
}
```

Then call `sendEmailAlert(newlyAvailable)` inside `scrapeAll()` where it broadcasts `new_available`.

**Limits:** ~500 emails/day. Fine for personal use.  
**Caveat:** May land in spam on first send — mark "Not Spam" once and it improves.

---

### Email — Resend (best free API, no spam issues)

[Resend](https://resend.com) offers **3,000 free emails/month** with a real sending domain, no credit card required.

**Setup:**
1. Sign up at resend.com → grab your API key
2. No npm needed — use Node's built-in `https`:

```js
async function sendResendAlert(games) {
  const list = games.map(g => `• ${g.venueLabel} — ${g.date} ${g.time} | ${g.difficulty} | ${g.spots} spots`).join('\n');

  const body = JSON.stringify({
    from: 'onboarding@resend.dev', // works without a custom domain
    to: ['you@example.com'],
    subject: `🏐 ${games.length} NYUrban spot${games.length > 1 ? 's' : ''} opened!`,
    text: `New spots:\n\n${list}\n\nRegister: https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1`,
  });

  return new Promise((resolve, reject) => {
    const req = require('https').request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        'Authorization': 'Bearer re_YOUR_API_KEY',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
```

---

### SMS — No genuinely free options (but very cheap)

True free SMS from code isn't possible in 2025 — carrier regulations require registration and every provider charges per message. The most practical options:

| Option | Cost | Notes |
|---|---|---|
| **Twilio** | ~$0.0079/msg + $1.15/mo number | Most reliable, great docs, free trial credit |
| **Plivo** | ~$0.0055/msg | Cheaper than Twilio, similar API |
| **textbee.dev** | Free* | Uses your own Android phone as gateway — truly $0 but requires a phone stay on and connected |

**textbee (free Android gateway):**
Install the textbee app on an Android phone, then:

```js
async function sendSMSAlert(games) {
  const msg = `🏐 ${games.length} NYUrban spot(s) open: ${games.map(g => g.venueLabel + ' ' + g.date).join(', ')}`;
  const body = JSON.stringify({ recipients: ['+1YOURNUMBER'], message: msg });
  // POST to textbee API — see textbee.dev for your device_id and API key
}
```

**Workaround — SMS via email:**  
Most US carriers support email-to-text (though AT&T discontinued it in 2025, others still work):
- Verizon: `number@vtext.com`
- T-Mobile: `number@tmomail.net`
- AT&T: discontinued
Just send a regular email to that address using the Gmail/Resend setup above.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "No sessions found" | All venues currently show "No Open Session" — check nyurban.com directly |
| Server errors on startup | Make sure Node v16+ is installed: `node --version` |
| Blank browser page | Check PowerShell — the server may have crashed, restart with `node server.js` |
| Notifications not showing | Click "Enable Notifications" in the UI, then allow in browser settings |

---

## License

MIT — free for personal use.
