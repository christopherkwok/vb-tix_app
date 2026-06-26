# NYUrban Volleyball Tracker

Scrapes the [NYUrban open play schedule](https://www.nyurban.com/?page_id=400&filter_id=1&gametypeid=1) on a schedule and shows ticket availability in a live-updating dashboard. Per-user email alerts fire when a newly available session matches your saved rules.

**Live tracker: https://christopherkwok.github.io/vb-tix_app/**

---

## Features

- All 5 venues — Laguardia/Fri, Beacon/Fri, Brandeis/Fri, Brandeis/Sun, Clinics
- Game data loads publicly — no login required
- Contextual multiselect filters — Difficulty, Court, Time dropdowns show only options present in current view
- Multi-key sort — click any sort chip to add it; click again to reverse; rank badge shows priority
- Email alerts — rule-based notifications via Resend; configure in the in-app Alerts panel
- Magic link sign-in — no password; each user manages their own alert rules
- One-click unsubscribe — each alert email includes a link to disable that rule without logging in

---

## Architecture overview

```
cron-job.org (every 10 min)
    → POST GitHub Actions API → triggers scrape.yml (workflow_dispatch)
    → node scraper.js
        → reads previous scrape_results from Supabase (to detect newly-opened spots)
        → reads enabled alert_rules from Supabase
        → scrapes all 5 venues via NYUrban AJAX endpoint
        → upserts game data to Supabase scrape_results table
        → for each rule with newly-matched spots: sends email via Resend HTTP API
          (email includes a one-click disable link with a unique disable_token)

GitHub Pages (docs/index.html)
    → on load: fetches scrape_results from Supabase using the anon key (no login needed)
    → if ?disable_token=<uuid> in URL: calls the disable-rule Edge Function, shows toast
    → Alerts button: opens side panel
        → signed out: shows magic link sign-in form
        → signed in: shows alert rules (CRUD) for the current user
    → magic link flow: user enters email → Supabase sends link via Resend SMTP
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
| Resend HTTP API | Scraper alert emails | `onboarding@resend.dev` | No |
| Resend SMTP (via Supabase) | Magic link emails | Your verified domain | Yes |

The scraper calls the Resend HTTP API directly (`api.resend.com/emails`) using `onboarding@resend.dev` as the sender — this works on Resend's free tier without domain verification. Supabase's SMTP path for magic links requires a verified domain as the sender address.

---

## Database schema

### `scrape_results` (one row, id = 1)

| Column | Type | Description |
|--------|------|-------------|
| `id` | int | Always 1 — singleton row |
| `games` | jsonb | Array of all scraped game objects |
| `last_scrape` | timestamptz | ISO timestamp of last successful scrape |
| `errors` | jsonb | Map of `venueId → error message` for failed venues |

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
| `filters` | jsonb | `{gym, date, time, difficulty, court}` — each an array of strings |
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

Repo → Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / Folder: `/docs` → Save.

Your live URL: `https://YOUR_USERNAME.github.io/vb-tix_app/`

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
  errors      jsonb not null default '{}'
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

**Disable public sign-ups** (invite-only):
Supabase → Authentication → Settings → toggle off **"Enable sign-ups"** → Save.

**Add your site to the redirect allow-list:**
Authentication → URL Configuration → add to Redirect URLs:
```
https://YOUR_USERNAME.github.io/vb-tix_app/
```

**Invite a user:**
Authentication → Users → **Invite user** → enter their email. They receive a magic link; no password needed.

### 7. Set up Resend

Sign up at [resend.com](https://resend.com) (free, 3,000 emails/month, no CC). Copy your API key (`re_...`).

For magic link emails via SMTP, go to **Domains** in the Resend dashboard and verify a domain you own — this is required for the SMTP sender address. Scraper alert emails use `onboarding@resend.dev` via the HTTP API and do not require domain verification.

### 8. Configure Supabase SMTP

Supabase → Authentication → **SMTP Settings** → enable custom SMTP:

| Field | Value |
|-------|-------|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | Your Resend API key (`re_...`) |
| Sender email | `noreply@yourdomain.com` (must be verified in Resend) |
| Sender name | `NYUrban Alerts` (or anything you like) |

Save, then test by triggering a sign-in from the Alerts panel.

> The SMTP username is always the literal string `resend` — not your email or account name.

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
| `RESEND_KEY` | Yes | Your Resend API key (`re_...`) |
| `ALERT_EMAIL` | Optional | Email address to receive test emails (used only in test-email mode) |

### 11. Set up reliable cron via cron-job.org

GitHub's built-in `on: schedule` cron is often delayed 15–30 min or silently skipped on free accounts. Use [cron-job.org](https://cron-job.org) (free, no CC) to trigger the workflow via `workflow_dispatch` instead — this goes into a higher-priority queue and fires reliably.

**Create a GitHub Personal Access Token (fine-grained):**
GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token

Repository permissions needed:
- **Metadata**: Read (auto-included)
- **Actions**: Read and Write

Copy the token.

**Create a cronjob at cron-job.org:**

| Field | Value |
|-------|-------|
| URL | `https://api.github.com/repos/YOUR_USERNAME/vb-tix_app/actions/workflows/scrape.yml/dispatches` |
| Execution schedule | Every 10 minutes |
| Request method | `POST` |
| Request body | `{"ref":"main"}` |

Under **Headers**, add:

| Key | Value |
|-----|-------|
| `Authorization` | `Bearer YOUR_GITHUB_PAT` |
| `Accept` | `application/vnd.github+json` |
| `Content-Type` | `application/json` |

A successful trigger returns HTTP 204. cron-job.org shows the response code in its job history — confirm this before assuming the cron is working.

> The PAT is stored only in cron-job.org. It is not in the repo, GitHub secrets, or Supabase.

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
                            # Sends alert emails via Resend HTTP API (onboarding@resend.dev)
supabase/
└── functions/
    └── disable-rule/
        └── index.ts        # Edge Function: one-click alert disable from email link
                            # Deployed with JWT verification OFF
                            # Called by frontend with ?token=<disable_token>
.github/
└── workflows/
    ├── scrape.yml          # Scraper workflow — triggered by cron-job.org via workflow_dispatch
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
| Resend emails | 3,000/month | Only sends on matched alerts |
| GitHub Actions minutes | 2,000 min/month | ~30 sec/run × 144 runs/day ≈ 72 min/day |
| cron-job.org | Free | Unlimited triggers |

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

### Column parsing

The HTML table columns are: `Select | Date | Gym | Level | Time | Fee | Available`

The **Level** column (e.g. `"Intermediate - Court 1"`, `"Advanced - Small Ct"`) is split into:
- `difficulty` — `"Intermediate"`, `"Advanced"`, `"Beginner"`, etc.
- `court` — `"Court 1"`, `"Court 2"`, `"Small Ct"`, or `"N/A"`

The **Available** column is a number (`3`, `0`) or `"Sold Out"`.

### Alert matching

Rules fire **once per opening event** — when a session transitions from unavailable to available. If the same session sells out and reopens, it fires again. Alerts don't repeat while a session stays continuously available across scrapes.

Filter matching per field:
- `gym`, `date`, `time` — case-insensitive partial match
- `difficulty`, `court` — case-insensitive exact match

A field with no values selected matches anything (wildcard).

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
| Sign-in email not arriving | Supabase → Logs → Auth for SMTP error; re-enter Resend API key as SMTP password; confirm sender email is a verified Resend domain |
| Magic link redirects to wrong URL | Add Pages URL to Supabase → Auth → URL Configuration → Redirect URLs |
| Edge Function returns 401 | JWT verification must be turned off on the `disable-rule` function |
| Disable link shows "already used" | Rule is already disabled — re-enable it from the Alerts panel |
| cron-job.org returns non-204 | Verify PAT has Actions Read/Write permission and hasn't expired; confirm request body is `{"ref":"main"}` |
| Pages shows stale content after merge | Run the Deploy Pages workflow manually: Actions → Deploy Pages → Run workflow |

---

## License

MIT — free for personal use.
