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

## How it works

```
cron-job.org (every 10 min)
    → POST GitHub Actions API → triggers scrape.yml
    → node scraper.js
        → scrapes all 5 venues
        → upserts game data to Supabase (scrape_results table)
        → reads per-user alert rules from Supabase (alert_rules table)
        → sends email alerts via Resend to each user whose rules matched
        → each alert email includes a one-click disable link

GitHub Pages (docs/index.html)
    → loads game data from Supabase directly (no login needed)
    → users sign in via magic link (email → one-time link, no password)
    → signed-in users manage alert rules in the Alerts panel
    → clicking a disable link in an email calls a Supabase Edge Function
      to toggle off that rule without requiring login
```

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
  id           int primary key default 1,
  games        jsonb not null default '[]',
  last_scrape  timestamptz,
  errors       jsonb not null default '{}'
);
insert into public.scrape_results (id) values (1) on conflict do nothing;
alter table public.scrape_results enable row level security;
create policy "public read scrape_results" on public.scrape_results
  for select using (true);

-- Per-user alert rules
create table public.alert_rules (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) on delete cascade not null,
  user_email     text not null,
  label          text not null,
  enabled        boolean not null default true,
  filters        jsonb not null default '{}',
  disable_token  uuid default gen_random_uuid(),
  created_at     timestamptz default now()
);
alter table public.alert_rules enable row level security;
create policy "user_owns_rules" on public.alert_rules
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());
```

### 5. Configure Supabase auth

**Disable public sign-ups** (invite-only):
Supabase → Authentication → Settings → toggle off **"Enable sign-ups"** → Save.

**Add your site to the redirect allow-list:**
Authentication → URL Configuration → add to Redirect URLs:
```
https://YOUR_USERNAME.github.io/vb-tix_app/
```

**Invite a user:**
Authentication → Users → **Invite user** → enter their email. They receive a magic link; no password needed.

### 6. Set up Resend

Sign up at [resend.com](https://resend.com) (free, 3,000 emails/month, no CC). Go to **Domains** and verify a domain you own — this is required for SMTP sending. Copy your API key (`re_...`).

### 7. Configure Supabase SMTP

Supabase → Authentication → **SMTP Settings** → enable custom SMTP:

| Field | Value |
|-------|-------|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | Your Resend API key (`re_...`) |
| Sender email | `noreply@yourdomain.com` (must be verified in Resend) |
| Sender name | `NYUrban Alerts` (or anything you like) |

Save, then test by inviting a user or triggering a sign-in.

> **Note:** `onboarding@resend.dev` only works via the Resend HTTP API — it cannot be used as the SMTP sender. You must use a domain you've verified in your Resend account.

### 8. Deploy the Edge Function

In Supabase dashboard → **Edge Functions** → **New function**:

1. Name it `disable-rule`
2. Paste the contents of [`supabase/functions/disable-rule/index.ts`](supabase/functions/disable-rule/index.ts)
3. **Turn off JWT verification** before deploying (so email links work without auth)
4. Deploy

This function handles one-click alert disabling from email links. It uses the `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment variables, which Supabase injects automatically — no additional config needed.

### 9. Add GitHub repository secrets

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|--------|-------|
| `SUPABASE_URL` | Your Supabase project URL (e.g. `https://abcdef.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Project Settings → API → **service_role** key (never expose this publicly) |
| `RESEND_KEY` | Your Resend API key (`re_...`) |

> **`SUPABASE_URL` and `SUPABASE_ANON_KEY`** are already hardcoded in `docs/index.html` — the anon key is safe to commit publicly (it's subject to Row Level Security and cannot bypass it).

### 10. Set up reliable cron via cron-job.org

GitHub's built-in cron is often delayed 15–30 min or silently skipped on free accounts. Use [cron-job.org](https://cron-job.org) (free, no CC) instead.

**Create a GitHub Personal Access Token (PAT):**
GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → scope: `workflow` only. Copy the token.

**Create a cronjob at cron-job.org:**

| Field | Value |
|-------|-------|
| URL | `https://api.github.com/repos/YOUR_USERNAME/vb-tix_app/actions/workflows/scrape.yml/dispatches` |
| Execution schedule | Every 10 minutes |
| Request method | `POST` |
| Request body | `{"ref":"main"}` |

Under **Headers**, add:
```
Authorization: Bearer YOUR_GITHUB_PAT
Accept: application/vnd.github+json
Content-Type: application/json
X-GitHub-Api-Version: 2022-11-28
```

A successful trigger returns HTTP 204. cron-job.org shows the response code in its job history.

### 11. Trigger the first scrape

Repo → Actions → **Scrape NYUrban** → **Run workflow** → Run. This populates the database so the frontend has data to display immediately.

---

## File structure

```
docs/
└── index.html              # Cloud frontend (Supabase auth + live data)
scraper.js                  # GitHub Actions scraper (zero npm dependencies)
supabase/
└── functions/
    └── disable-rule/
        └── index.ts        # Edge Function: one-click alert disable from email
.github/
└── workflows/
    ├── scrape.yml          # Scraper workflow (triggered by cron-job.org)
    └── deploy-pages.yml    # Manual Pages rebuild trigger
debug/                      # One-shot diagnostic scripts
config/
└── alerts.json             # Alert rule format reference (file-based mode)
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
| "Could not load game data" | Trigger the scraper manually: Actions → Scrape NYUrban → Run workflow |
| Game data not updating | Check GitHub Actions logs for scraper errors; verify Supabase secrets are set |
| Sign-in email not arriving | Check Supabase → Logs → Auth for SMTP errors; re-enter Resend API key as SMTP password |
| Magic link redirects to wrong URL | Add your Pages URL to Supabase → Auth → URL Configuration → Redirect URLs |
| Edge Function returns 401 | JWT verification must be turned off on the `disable-rule` function |
| cron-job.org returns non-204 | Verify the PAT has `workflow` scope and hasn't expired |

---

## License

MIT — free for personal use.
