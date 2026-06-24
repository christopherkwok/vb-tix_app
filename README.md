# 🏐 Volleyball Ticket Tracker

A lightweight, **zero-dependency** Node.js app that scrapes the [open play schedule](https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1) every 5 minutes and shows ticket availability in a live-updating UI.

---

## Features

- ✅ **All 5 venues** — Laguardia/Fri, Beacon/Fri, Brandeis/Fri, Brandeis/Sun, Clinics
- ✅ **Real-time UI** — Server-Sent Events (SSE) push updates instantly to the browser
- ✅ **Contextual multiselect filters** — Difficulty, Court, and Time dropdowns show only options present in the current view; selecting multiple values in one group narrows the others automatically
- ✅ **Multi-key sort** — click any sort chip to add it as a sort key; click again to reverse; a rank badge shows priority when multiple sorts are active
- ✅ **Browser notifications** — opt-in alerts when new spots open
- ✅ **Email alerts** — rule-based email notifications via Gmail App Password or Resend API; configured through the in-app 🔔 Alerts panel or directly in `notifications.json`
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

## Live Tracker

**https://christopherkwok.github.io/vb-tix_app/**

---

## Cloud Deployment (Free, No Credit Card)

Host the tracker permanently using **GitHub Actions** (scraper cron) + **GitHub Pages** (frontend) + **Supabase** (database + auth). All free tiers, no credit card required.

### How it works

```
GitHub Actions (every 10 min)
    → node scraper.js
    → scrapes all 5 venues
    → upserts game data to Supabase (scrape_results table)
    → reads per-user alert rules from Supabase (alert_rules table)
    → sends email alerts via Resend to each user whose rules matched

GitHub Pages
    → serves docs/index.html (your dashboard)
    → users sign in with magic link (email → one-time link, no password)
    → frontend queries Supabase directly for game data and alert rules
```

### Setup

**1. Create a Supabase project**

Sign up at [supabase.com](https://supabase.com) (free, no CC). Create a new project, then run this SQL in the **SQL Editor** tab:

```sql
-- Game data table (one row, updated each scrape)
create table public.scrape_results (
  id int primary key default 1,
  games jsonb not null default '[]',
  last_scrape timestamptz,
  errors jsonb not null default '{}'
);
insert into public.scrape_results (id) values (1) on conflict do nothing;
alter table public.scrape_results enable row level security;
create policy "auth_read" on public.scrape_results
  for select to authenticated using (true);

-- Per-user alert rules
create table public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  user_email text not null,
  label text not null,
  enabled boolean not null default true,
  filters jsonb not null default '{}',
  created_at timestamptz default now()
);
alter table public.alert_rules enable row level security;
create policy "user_owns_rules" on public.alert_rules
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

**2. Disable public sign-ups (invite-only access)**

In your Supabase dashboard → **Authentication → Providers → Email** → uncheck **"Enable email confirmations"** (or leave on for extra security) → go to **Authentication → Settings** → toggle off **"Enable sign-ups"**. Save.

To invite a user: **Authentication → Users → Invite user** (enter their email). They receive a magic link; no password needed.

**3. Add your site URL to the redirect allow-list**

In Supabase dashboard → **Authentication → URL Configuration** → add your GitHub Pages URL to **Redirect URLs**:
```
https://YOUR_USERNAME.github.io/vb-tix_app/
```

**4. Add your Supabase keys to `docs/index.html`**

Find these two lines near the top of the `<script>` block and replace the placeholders:
```js
const SUPABASE_URL      = 'YOUR_SUPABASE_URL';       // e.g. https://abcdef.supabase.co
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';  // Project Settings → API → anon public
```

**5. Push to a public GitHub repository**
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/vb-tix_app.git
git push -u origin main
```

**6. Enable GitHub Pages**  
Repo → Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / Folder: `/docs` → Save.

Your live URL: `https://YOUR_USERNAME.github.io/vb-tix_app/`

**7. Enable GitHub Actions**  
Repo → Actions tab → click "I understand my workflows, go ahead and enable them."

**8. Add GitHub repository secrets**  
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret name | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL (e.g. `https://abcdef.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Project Settings → API → **service_role** key (keep secret!) |
| `RESEND_KEY` | Your Resend API key (free at [resend.com](https://resend.com), no CC) |

> `ALERT_EMAIL` is no longer needed — each user's rules send to their own email address.

### File structure for cloud

```
docs/
└── index.html      # Cloud frontend — Supabase auth + live game data

scraper.js          # Standalone Node.js scraper — writes to Supabase
.github/
└── workflows/
    └── scrape.yml  # Cron job (every 10 min) + Supabase secrets
```

### Differences from the local version

| Feature | Local (`server.js`) | Cloud (GitHub Pages + Supabase) |
|---|---|---|
| Updates | Real-time via SSE | Polling every 5 minutes |
| Auth | None (local network) | Magic link email (no password) |
| Alert rules | Configured in 🔔 Alerts panel, stored in `notifications.json` | Configured in 🔔 Alerts panel, stored per-user in Supabase |
| Multiple users | Single shared config | Each user manages their own rules, alerts sent to their email |
| Force refresh | ↻ Refresh button | Trigger via Actions → Run workflow |
| Scrape interval | 5 minutes (configurable) | 10 minutes (GitHub cron minimum) |

### Free tier limits (Supabase)

| Resource | Free limit | This app's usage |
|---|---|---|
| Monthly active users | 50,000 | Negligible |
| Database | 500 MB | ~1 MB (game data is tiny) |
| Auth emails | 4/hour (magic links) | Fine for a small group |
| API requests | No hard cap | Polling 5 min = ~300/day/user |
| Project pausing | After 7 days inactivity | Won't happen — cron keeps it active |

---

## How It Works

```
Browser (SSE) ←──── Node.js server (port 3333) ────→ venue site
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

## File Structure

```
vb-tix_tracker/
├── server.js            # Node.js backend — scraping, SSE, API, email
├── index.html           # Single-page frontend — all CSS + JS inline
├── notifications.json   # Email config + alert rules (auto-created on first save)
├── debug/
│   ├── debug-fetch.js   # Step 1: scrapes main page + tests AJAX actions
│   ├── debug-fetch2.js  # Step 2: fetches openplay.js + brute-forces AJAX params
│   ├── debug-fetch3.js  # Step 3: confirms correct action/buttonid per venue
│   └── debug-output/    # Raw HTML saved by the debug scripts
└── README.md
```

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

## UI Features

### Venue tabs
One tab per venue plus an "All Venues" reset. Each tab shows a count badge and a colour dot: green = at least one open spot, red = all sold out, grey = no sessions. Click individual venue tabs to toggle them — multiple venues can be selected simultaneously (they highlight green). Clicking "All Venues" clears all selections and shows everything.

### Availability filter
Three chips — **All**, **Available only**, **Sold out** — that pre-filter before the dropdown filters apply.

### Contextual multiselect dropdowns (Difficulty / Court / Time)
Each dropdown shows only the values that exist in the remaining filtered view after the other two dropdowns are applied. Selecting e.g. "Advanced" from Difficulty automatically removes Time options that have no Advanced sessions. Active selections that disappear from the available pool are silently cleared.

### Multi-key sort
Click a sort chip to make it the primary sort (ascending ↑). Click again to reverse (↓). Click a third time to remove it. When more than one sort is active, a numbered rank badge appears on each chip showing priority order. Clicking a new chip appends it at the lowest priority. "✕ Clear sort" resets everything.

### Email Alerts panel (🔔 Alerts)
Opens a modal for configuring server-side email notifications:

- **Delivery settings** — organised as two options with required-field `*` markers:
  - *Option A — Gmail*: recipient address `*`, Gmail sender address `*`, Gmail App Password `*`
  - *Option B — Resend*: recipient address `*`, Resend API key `*`
- **Alert rules** — each rule triggers an email when a newly available session matches all its filters. Filters use the same multiselect dropdowns as the main page, populated from live game data — select one or more values per field, or leave a field unselected to match anything. All 5 fields are always shown in the rule card — green = at least one value set, grey italic "Any" = unset.
- **Send test email** — verifies credentials without waiting for a real scrape

Settings are stored in `notifications.json` and survive server restarts.

---

## Changing the Poll Interval

Edit the last line of `server.js`:

```js
startPolling(5 * 60 * 1000); // every 5 minutes — change as needed
```

---

## `notifications.json` Reference

This file is created automatically when you first save settings through the UI. You can also edit it directly:

```json
{
  "email": "you@example.com",
  "gmailUser": "sender@gmail.com",
  "gmailPass": "xxxx xxxx xxxx xxxx",
  "resendKey": "re_...",
  "rules": [
    {
      "id": "rule-1",
      "label": "Beacon Advanced Friday nights",
      "enabled": true,
      "filters": {
        "gym":        ["Beacon"],
        "date":       [],
        "time":       ["7:00 pm"],
        "court":      [],
        "difficulty": ["Advanced"]
      }
    }
  ]
}
```

Filter values are arrays — the rule matches if the game's value equals **any** entry in the array (OR within a field). A field with an empty array matches any value. All fields must match for a rule to fire (AND across fields).

Matching rules per field:
- `gym`, `date`, `time` — case-insensitive **partial** match
- `difficulty`, `court` — case-insensitive **exact** match

**When alerts fire:** once per opening event — when a session transitions from unavailable (or unseen) to available. If the same session later sells out and reopens, it fires again. Alerts do not repeat while a session remains continuously available across scrapes.

---

## Debug Scripts

The `debug/` folder contains three one-shot scripts for diagnosing issues with the AJAX endpoint. Run them manually when the scraper breaks:

```bash
# Step 1 — fetch main page, test AJAX action names
node debug/debug-fetch.js

# Step 2 — fetch openplay.js, brute-force AJAX parameter combos
node debug/debug-fetch2.js

# Step 3 — confirm correct action + buttonid per venue
node debug/debug-fetch3.js
```

Each script saves raw HTML responses to `debug/debug-output/`. Share that folder when reporting issues.

---

## 📧 Email & 📱 Text Notifications (Setup Guide)

Browser notifications work out of the box (click "Enable Notifications" in the UI). Email alerts are **built in** — no code changes needed. Open the 🔔 Alerts panel in the UI and follow the steps for your chosen sending method.

### Option A — Gmail (easiest, truly free)

Uses your own Gmail account as the sender. Nodemailer is used if installed (`npm install nodemailer`); otherwise the server falls back to Resend if configured.

**Setup:**
1. Enable 2-Factor Authentication on your Google account
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) → create an App Password for "Mail"
3. In the 🔔 Alerts panel, fill in:
   - **Send alerts to** — the address that receives alerts
   - **Gmail sender address** — your Gmail address (the sender)
   - **Gmail App Password** — the 16-character code from step 2 (not your regular password)
4. Click **Save settings**, then **Send test email** to confirm it works

**Limits:** ~500 emails/day. Fine for personal use.  
**Caveat:** May land in spam on first send — mark "Not Spam" once and it improves.

---

### Option B — Resend (best free API, no spam issues)

[Resend](https://resend.com) offers **3,000 free emails/month** with a real sending domain, no credit card required. No npm install needed.

**Setup:**
1. Sign up at [resend.com](https://resend.com) → grab your API key
2. In the 🔔 Alerts panel, fill in:
   - **Send alerts to** — the address that receives alerts
   - **Resend API key** — paste your `re_...` key
3. Click **Save settings**, then **Send test email** to confirm it works

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
  const msg = `🏐 ${games.length} spot(s) open: ${games.map(g => g.venueLabel + ' ' + g.date).join(', ')}`;
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
| "No sessions found" | All venues currently show "No Open Session" — check the site directly |
| Server errors on startup | Make sure Node v16+ is installed: `node --version` |
| Blank browser page | Check PowerShell — the server may have crashed, restart with `node server.js` |
| Notifications not showing | Click "Enable Notifications" in the UI, then allow in browser settings |

---

## License

MIT — free for personal use.
