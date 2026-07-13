# NYUrban Volleyball Tracker

Scrapes the [NYUrban open play schedule](https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1) on a schedule and shows ticket availability in a live-updating dashboard. Per-user email alerts fire when a newly available session matches your saved rules.

**Live tracker: https://christopherkwok.github.io/vb-tix_app/**

---

## Features

- All 5 venues — Laguardia/Fri, Beacon/Fri, Brandeis/Fri, Brandeis/Sun, Clinics
- Game data loads publicly — no login required
- Contextual multiselect filters — Difficulty, Court, Time dropdowns show only options present in current view
- Multi-key sort — click any sort chip to add it; click again to reverse; rank badge shows priority
- Email alerts — rule-based notifications via Brevo; configure in the in-app Alerts panel
  - Up to 5 rules per user; each rule filters by venue, time, difficulty, and/or court
  - Historical combo catalog — alert rules can be created even when no sessions are currently listed (between seasons or pre-release), using values from past scrapes
- Browser notifications — in-browser alerts when spots open; enable without logging in
- Magic link sign-in — no password; each user manages their own alert rules (invite-only)
- One-click unsubscribe — each alert email includes a link to disable that rule without logging in

---

## Architecture overview

```
Cloudflare Worker cron (*/5 * * * *)
    → POST GitHub Actions API → triggers scrape.yml (workflow_dispatch)
    → node scraper.js
        → reads previous scrape_results from Supabase (games + catalog)
        → reads enabled alert_rules from Supabase
        → scrapes all 5 venues via NYUrban AJAX endpoint
        → upserts game data + updated catalog to Supabase scrape_results table
          (catalog accumulates unique venue/time/difficulty/court combos seen across all runs)
        → for each rule with newly-matched spots: sends email via Brevo HTTP API
          (email includes a one-click disable link with a unique disable_token)

GitHub Pages (docs/index.html)
    → on load: fetches scrape_results from Supabase using the anon key (no login needed)
    → if ?disable_token=<uuid> in URL: calls the disable-rule Edge Function, shows toast
    → Alerts button: opens side panel
        → browser notifications section (visible without login)
        → signed out: shows magic link sign-in form
        → signed in: shows alert rules (CRUD) for the current user
          rule form dropdowns draw from live games + historical catalog so filters
          remain usable even when no sessions are currently posted;
          selecting a venue narrows time options to that venue's history,
          selecting a time narrows difficulty, selecting a difficulty narrows court
    → magic link flow: user enters email → Supabase sends link via Brevo SMTP
      → user clicks link → redirected back to app → onAuthStateChange fires → panel refreshes

Supabase Edge Function (disable-rule)
    → called by frontend with ?token=<uuid>
    → no JWT required (deployed with --no-verify-jwt)
    → sets alert_rules.enabled = false where disable_token matches
    → returns {ok: true, label: "rule name"} or 404
```

### Key credential distinctions

| Credential | Where stored | Used by | Can it bypass RLS? |
|------------|-------------|---------|-------------------|
| `SUPABASE_ANON_KEY` | Hardcoded in `docs/index.html` | Browser frontend | No — subject to RLS |
| `SUPABASE_SERVICE_KEY` | GitHub Actions secret | `scraper.js` | Yes — bypasses RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase | Edge Function | Yes — bypasses RLS |

The anon key is safe to commit publicly because Row Level Security prevents it from reading other users' alert rules or writing anything. The service key must never be public.

### Email sending — two distinct paths

| Path | Used for | Sender address | Requires verified domain? |
|------|----------|---------------|--------------------------|
| Brevo HTTP API | Scraper alert emails | Your verified Brevo sender email | No — sender email verification only |
| Brevo SMTP (via Supabase) | Magic link emails | Your verified Brevo sender email | No — sender email verification only |

Both paths use Brevo. The scraper calls the Brevo HTTP API (`api.brevo.com/v3/smtp/email`) with a `BREVO_KEY` and `BREVO_SENDER`. Supabase sends magic links via Brevo SMTP using a separate SMTP key. Neither requires full domain verification — only the sender email address must be verified in Brevo (Brevo → Senders & IP → Senders).

**How alert emails appear to recipients:**

Alert emails arrive with the sender displayed as:
```
NYUrban Alerts <vbtixalerts@11557122.brevosend.com>
```
The display name (`NYUrban Alerts`) is set in `BREVO_SENDER` config. The `brevosend.com` address is Brevo's relay domain — this is normal when sending from a verified Gmail address without full custom domain authentication. Recipients cannot reply directly; the email is notification-only.

---

## Database schema

### `scrape_results` (one row, id = 1)

| Column | Type | Description |
|--------|------|-------------|
| `id` | int | Always 1 — singleton row |
| `games` | jsonb | Array of all scraped game objects |
| `last_scrape` | timestamptz | ISO timestamp of last successful scrape |
| `errors` | jsonb | Map of `venueId → error message` for failed venues |
| `catalog` | jsonb | Cumulative unique `{combos: [{venue, time, difficulty, court}]}` across all scrapes — used by the alert rule form when no live sessions are posted |

RLS: public SELECT (anon key can read), writes use service key (bypasses RLS).

Each game object in the `games` array:
```json
{
  "id": "laguardia::fri-6/27::intermediate---court-1",
  "venueId": "laguardia",
  "venueLabel": "Laguardia / Fri",
  "date": "Fri 6/27",
  "gym": "Laguardia HS",
  "level": "Intermediate - Court 1",
  "difficulty": "Intermediate",
  "court": "Court 1",
  "time": "7:00 pm",
  "fee": "$28",
  "spots": "3",
  "available": true,
  "link": "https://www.nyurban.com/..."
}
```

### `alert_rules` (one row per user rule)

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `user_id` | uuid | References `auth.users(id)`, cascade delete |
| `user_email` | text | Used by scraper to address alert emails |
| `label` | text | Display name for the rule (e.g. "Friday Intermediate") |
| `enabled` | boolean | Whether the rule is active |
| `filters` | jsonb | `{venue, date, time, difficulty, court}` — each an array of strings (`gym` is a legacy field kept for backward compat) |
| `disable_token` | uuid | Random token embedded in alert emails for one-click disable |
| `created_at` | timestamptz | Auto-set |

RLS: authenticated users can only read/write their own rows (`user_id = auth.uid()`). The scraper reads all enabled rules using the service key (bypasses RLS). The Edge Function writes using the service role key (bypasses RLS).

Filter matching: `gym`, `date`, `time` use partial match; `difficulty`, `court` use exact match. An empty array for any field matches everything (wildcard).

---

## Setup

Everything runs on free tiers. No credit card required for any service.

### 1. Push repo to GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/vb-tix_app.git
git push -u origin main
```

### 2. Enable GitHub Pages

Repo → Settings → Pages → Source: **GitHub Actions** → Save.

Your live URL: `https://YOUR_USERNAME.github.io/vb-tix_app/`

Pages deploys automatically on every push to `main` via the **Deploy Pages** workflow (`deploy-pages.yml`). The same workflow can be triggered manually from the Actions tab if needed.

### 3. Enable GitHub Actions

Repo → Actions tab → click **"I understand my workflows, go ahead and enable them."**

### 4. Create a Supabase project

Sign up at [supabase.com](https://supabase.com) (free). Create a new project, then run this SQL in **SQL Editor**:

```sql
-- Game data (one row, updated each scrape)
create table public.scrape_results (
  id          int primary key default 1,
  games       jsonb not null default '[]',
  last_scrape timestamptz,
  errors      jsonb not null default '{}',
  catalog     jsonb not null default '{}'
);
insert into public.scrape_results (id) values (1) on conflict do nothing;
alter table public.scrape_results enable row level security;
create policy "public read scrape_results" on public.scrape_results
  for select using (true);

-- Per-user alert rules
create table public.alert_rules (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  user_email    text not null,
  label         text not null,
  enabled       boolean not null default true,
  filters       jsonb not null default '{}',
  disable_token uuid default gen_random_uuid(),
  created_at    timestamptz default now()
);
alter table public.alert_rules enable row level security;
create policy "user_owns_rules" on public.alert_rules
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());
```

### 5. Update Supabase credentials in `docs/index.html`

Find these two lines near the top of the `<script>` block and replace with your project's values:

```js
const SUPABASE_URL      = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

Get these from: Supabase → Project Settings → API → **Project URL** and **anon public** key.

The anon key is safe to commit — it is subject to RLS and cannot bypass it.

### 6. Configure Supabase auth

**Keep sign-ups enabled** (required for magic link to work):
Supabase → Authentication → Settings → confirm **"Enable sign-ups"** is ON. Disabling it also blocks magic link sign-ins for existing users (returns 422). Invite-only access is enforced at the app level — there is no self-registration form, and only users you explicitly invite can create accounts.

**Set the Site URL:**
Authentication → URL Configuration → **Site URL**:
```
https://YOUR_USERNAME.github.io/vb-tix_app/
```

**Add your site to the redirect allow-list:**
Authentication → URL Configuration → add to Redirect URLs:
```
https://YOUR_USERNAME.github.io/vb-tix_app/
```

**Customize email templates (optional but recommended):**
Supabase → Authentication → **Email Templates** — two templates are used by this app:

| Template | Subject |
|----------|---------|
| **Invite user** | `You've been invited to NYUrban Volleyball Tracker` |
| **Magic Link** | `Your sign-in link for NYUrban Volleyball Tracker` |

Paste the HTML from [`supabase/templates/invite.html`](supabase/templates/invite.html) and [`supabase/templates/magic-link.html`](supabase/templates/magic-link.html) into the respective template editors and save. These files are the source of truth for the templates — they are **not** deployed automatically and must be applied manually in the Supabase dashboard.

**Invite a user:**
Authentication → Users → **Invite user** → enter their email. They receive a magic link; no password needed.

### 7. Set up Brevo

Sign up at [brevo.com](https://brevo.com) (free, 300 emails/day, 9,000/month, no CC).

**Verify a sender email address** (no domain required):
Brevo → Senders & IP → Senders → **Add a sender** → enter the email address you want to send from → Brevo sends a confirmation email → click the link to verify.

**Get your API key** (for scraper alert emails):
Brevo → SMTP & API → **API Keys** tab → Generate a new API key. Copy it.

**Get your SMTP key** (for Supabase magic links — separate from the API key):
Brevo → SMTP & API → **SMTP** tab → Generate a new SMTP key. Copy it.

### 8. Configure Supabase SMTP

Supabase → Authentication → **SMTP Settings** → enable custom SMTP:

| Field | Value |
|-------|-------|
| Host | `smtp-relay.brevo.com` |
| Port | `587` |
| Username | Your Brevo SMTP login — found in Brevo → SMTP & API → SMTP tab → "Your SMTP Settings" (personal accounts get an assigned login like `b05902001@smtp-brevo.com`, not your account email) |
| Password | Your Brevo SMTP key (from SMTP & API → SMTP tab) |
| Sender email | Your verified Brevo sender email |
| Sender name | `NYUrban Alerts` (or anything you like) |

Save, then test by inviting a user or triggering a sign-in from the Alerts panel.

> The SMTP username for Brevo is your account email address — not a fixed string.

### 9. Deploy the Edge Function

In Supabase dashboard → **Edge Functions** → **New function**:

1. Name it `disable-rule`
2. Paste the contents of [`supabase/functions/disable-rule/index.ts`](supabase/functions/disable-rule/index.ts)
3. **Turn off JWT verification** before deploying — this allows the email link to call the function without an auth header
4. Deploy

The function uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which Supabase injects automatically into Edge Functions — no additional config needed.

### 10. Add GitHub repository secrets

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Required | Value |
|--------|----------|-------|
| `SUPABASE_URL` | Yes | Your Supabase project URL (e.g. `https://abcdef.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Yes | Project Settings → API → **service_role** key — never expose publicly |
| `BREVO_KEY` | Yes | Brevo API key (Brevo → SMTP & API → API Keys tab) |
| `BREVO_SENDER` | Yes | Your verified Brevo sender email address |
| `ALERT_EMAIL` | Optional | Email address to receive test emails (used only in test-email mode) |

### 11. Set up reliable cron via Cloudflare Workers

GitHub's built-in `on: schedule` cron is often delayed 15–30 min or silently skipped on free accounts. A Cloudflare Worker with a cron trigger fires reliably every 5 minutes and is more secure than a third-party service — the PAT is stored as an encrypted Cloudflare secret, never on an external platform.

**Create a GitHub Personal Access Token (fine-grained):**
GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token

Repository permissions needed:
- **Metadata**: Read (auto-included)
- **Actions**: Read and Write

Copy the token.

**Create a Cloudflare account:** Sign up at [cloudflare.com](https://cloudflare.com) (free, no CC).

**Create the Worker (via Cloudflare dashboard — no CLI required):**

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**
2. Name it `vb-tix-cron` → click **Deploy**
3. Click **Edit code** → delete the placeholder and paste the contents of [`workers/trigger/index.js`](workers/trigger/index.js) → **Save and deploy**
4. Go to the Worker → **Settings** → **Triggers** → **Cron Triggers** → **Add Cron Trigger** → enter `*/5 * * * *` → **Add Trigger**
5. Go to the Worker → **Settings** → **Variables and Secrets** → **Add** → type: **Secret** → name: `GITHUB_PAT` → paste the PAT → **Deploy**

Verify in the **Triggers** tab that `*/5 * * * *` is listed. A successful dispatch logs `GitHub dispatch: 204` in the Worker's logs.

> The PAT is stored only as a Cloudflare Worker secret. It is not in the repo, GitHub secrets, or Supabase.

### 12. Trigger the first scrape

Repo → Actions → **Scrape NYUrban** → **Run workflow** → Run. This populates the database so the frontend has data to display immediately.

---

## File structure

```
docs/
└── index.html              # Cloud frontend — Supabase auth + live game data
                            # SUPABASE_URL and SUPABASE_ANON_KEY hardcoded near top of <script>
scraper.js                  # GitHub Actions scraper — zero npm dependencies
                            # Uses SUPABASE_URL + SUPABASE_SERVICE_KEY env vars
                            # Sends alert emails via Brevo HTTP API (BREVO_KEY + BREVO_SENDER)
workers/
└── trigger/
    └── index.js            # Cloudflare Worker — fires every 5 min, POSTs to GitHub Actions API
wrangler.toml               # Cloudflare Workers config — cron schedule + Worker entrypoint
supabase/
├── functions/
│   └── disable-rule/
│       └── index.ts        # Edge Function: one-click alert disable from email link
│                           # Deployed with JWT verification OFF
│                           # Called by frontend with ?token=<disable_token>
└── templates/
    ├── invite.html         # Invite user email template — paste into Supabase → Auth → Email Templates
    └── magic-link.html     # Magic link sign-in template — paste into Supabase → Auth → Email Templates
                            # NOT auto-deployed; must be applied manually in the Supabase dashboard
.github/
└── workflows/
    ├── scrape.yml          # Scraper workflow — triggered by Cloudflare Worker via workflow_dispatch
    └── deploy-pages.yml    # Manual Pages rebuild — run via Actions if Pages gets stale
debug/                      # One-shot diagnostic scripts for AJAX endpoint issues
```

---

## Free tier limits

| Resource | Free limit | This app's usage |
|----------|------------|-----------------|
| Supabase database | 500 MB | ~1 MB (game data is tiny) |
| Supabase auth emails | 4/hour | Fine for a small group |
| Supabase API requests | No hard cap | Polling every 5 min ≈ 300/day/user |
| Supabase project pausing | After 7 days inactivity | Won't happen — cron keeps it active |
| Brevo emails | 300/day, 9,000/month | Only sends on matched alerts |
| GitHub Actions minutes | 2,000 min/month | ~30 sec/run × 288 runs/day ≈ 144 min/day |
| Cloudflare Workers | Free (100k req/day) | 288 triggers/day — well within limit |

---

## How the scraper works

### AJAX endpoint

Each venue tab is loaded via a POST to the NYUrban WordPress AJAX handler:

```
POST https://www.nyurban.com/wp-admin/admin-ajax.php
action=my_open_play_contentbb&buttonid=BUTTON_ID&gametypeid=1&filterid=FILTER_ID
```

| Venue | filterId | buttonId |
|-------|----------|----------|
| Laguardia / Fri | 35 | 1 |
| Beacon / Fri | 34 | 2 |
| Brandeis / Fri | 6 | 3 |
| Brandeis / Sun | 18 | 4 |
| Clinics | 32 | 5 |

The venue label strings (`"Laguardia / Fri"`, `"Beacon / Fri"`, etc.) are the canonical identifiers used for exact-match filtering throughout the app. They are defined in two places that must stay in sync: `VENUES[].label` in `scraper.js` and `VENUE_LABELS` (a hardcoded array constant) in `docs/index.html`. Adding a new venue requires updating both.

### Column parsing

The HTML table columns are: `Select | Date | Gym | Level | Time | Fee | Available`

The **Level** column (e.g. `"Intermediate - Court 1"`, `"Advanced - Small Ct"`) is split into:
- `difficulty` — `"Intermediate"`, `"Advanced"`, `"Beginner"`, etc.
- `court` — `"Court 1"`, `"Court 2"`, `"Small Ct"`, or `"N/A"`

The **Available** column is a number (`3`, `0`) or `"Sold Out"`.

### Alert matching

Rules fire **once per opening event** — when a session transitions from unavailable to available. If the same session sells out and reopens, it fires again. Alerts don't repeat while a session stays continuously available across scrapes.

Filter matching per field:
- `venue`, `difficulty`, `court` — case-insensitive exact match
- `date`, `time` — case-insensitive partial match
- `gym` — legacy partial match field kept for backward compatibility with old rules

A field with no values selected matches anything (wildcard).

### Alert email format

Each alert email subject shows the session details of the opening event rather than the rule name:

- **Single match:** `🏐 1 spot just opened — Laguardia / Fri | Fri 7/11 | 7:00 pm | Intermediate`
- **Multiple matches:** `🏐 3 spots just opened — Laguardia / Fri + 2 more`

The email body includes the rule name at the top followed by the full session list.

### Historical combo catalog

The scraper accumulates a `catalog` of unique `(venue, time, difficulty, court)` combinations seen across all scrapes and stores it in `scrape_results.catalog.combos`. When sessions are not currently posted on the NYUrban website (between seasons or pre-release), the alert rule form draws from this catalog so users can still create standing alerts for their preferred sessions. The catalog grows automatically with each scrape and never needs to be reset.

### One-click unsubscribe flow

1. Scraper reads `rule.disable_token` from the `alert_rules` row
2. Embeds `https://christopherkwok.github.io/vb-tix_app/?disable_token=<uuid>` in the email body
3. User clicks link → browser opens the app with `?disable_token=<uuid>` in the URL
4. `docs/index.html` boot sequence detects the param, calls the `disable-rule` Edge Function
5. Edge Function sets `enabled = false` on the matching rule, returns `{ok: true, label: "..."}`
6. Frontend shows a toast: `"Alert '...' has been disabled."`

---

## Debug scripts

The `debug/` folder contains one-shot scripts for diagnosing issues with the AJAX endpoint. Run them manually when the scraper breaks:

```bash
node debug/debug-fetch.js   # fetch main page, test AJAX action names
node debug/debug-fetch2.js  # fetch openplay.js, brute-force AJAX params
node debug/debug-fetch3.js  # confirm correct action + buttonid per venue
```

Each script saves raw HTML to `debug/debug-output/`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Could not load game data" on page load | Trigger scraper manually: Actions → Scrape NYUrban → Run workflow |
| Game data not updating | Check GitHub Actions logs; verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` secrets are set |
| Sign-in email not arriving | Supabase → Logs → Auth for SMTP error; confirm Brevo SMTP key (`xsmtpsib-...`) is in the Password field (not the API key); confirm Username is the Brevo-assigned SMTP login (Brevo → SMTP & API → SMTP tab → "Your SMTP Settings"), not your account email |
| Magic link returns 422 / "Signup disabled" | Re-enable sign-ups: Supabase → Authentication → Settings → turn **"Enable sign-ups"** ON (disabling it also blocks magic link for existing users) |
| Magic link redirects to wrong URL | Set the correct Site URL: Supabase → Auth → URL Configuration → Site URL → `https://YOUR_USERNAME.github.io/vb-tix_app/`; also add that URL to Redirect URLs |
| Alert rule form shows no filter options | Trigger a manual scrape to seed the catalog: Actions → Scrape NYUrban → Run workflow |
| Edge Function returns 401 | JWT verification must be turned off on the `disable-rule` function |
| Disable link shows "already used" | Rule is already disabled — re-enable it from the Alerts panel |
| Cloudflare Worker logs non-204 | Verify PAT has Actions Read/Write permission and hasn't expired; run `wrangler secret put GITHUB_PAT` to update it |
| Pages shows stale content after merge | Deploy Pages runs automatically on every push to main; force manually: Actions → Deploy Pages → Run workflow |

---

## License

MIT — free for personal use.
