# Deploy 9vercel to Vercel + Supabase

> Local dev (Laragon/Windows) works with SQLite and zero config.
> Vercel requires Supabase — the Vercel filesystem is ephemeral (SQLite data is wiped on every deploy).

For the Indonesian version, see [`DEPLOY_VERCEL_ID.md`](./DEPLOY_VERCEL_ID.md).

---

## 1) Supabase — one-time setup

### A. Create / open a project
1. Supabase Dashboard → New project → give it a name, set a database password, pick the nearest region.
2. Note the **project ref** (the `<ref>.supabase.co` part of the Project URL) and the **region** — the pooler hostname embeds the region (e.g. `aws-0-<region>.pooler.supabase.com`). Never guess the hostname — always copy it from your own project's dashboard.

### B. Run the schema SQL
1. Open **Supabase Dashboard → SQL Editor → New query**
2. Copy-paste the full contents of `supabase/schema.sql` from this repo → **Run**
3. Safe to re-run (`IF NOT EXISTS`). Must succeed with no errors.

It creates 11 tables: `_meta`, `settings`, `providerConnections`, `providerNodes`, `proxyPools`, `apiKeys`, `combos`, `kv`, `usageHistory`, `usageDaily`, `requestDetails` + seed `settings(id=1)`.

> **Boot safety net:** the schema can also auto-create at boot (migration `001-initial` runs at Vercel build/runtime even if `supabase/schema.sql` was never run manually). Still, running it once manually is the supported, verifiable path.

### C. Get the right `DATABASE_URL`
In **Project Settings → Database → Connection string → URI**:

- **For Vercel / serverless — you MUST use the Transaction Pooler (port 6543):**
  ```
  postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true
  ```
  Copy the entry labeled **Transaction pooler** (or **Session pooler / 6543**) from your own dashboard. Do not use `db.<ref>.supabase.co:5432` for Vercel — direct connections often hit `ENETUNREACH` IPv6 during Vercel builds and exhaust `max_connections` (`too many clients`) without pgbouncer.

  > The pooler host follows your project's region (e.g. `aws-0-ap-southeast-1`, `aws-0-us-east-1`). Always copy from the dashboard, never guess.

- **For local/dev** either string works; the `6543?pgbouncer=true` pooler string is verified to work locally too.

> Replace `[YOUR-PASSWORD]` with the **database password** you set at project creation.
> Forgot it? **Project Settings → Database → Reset database password**.

### D. Publishable key — not needed for the DB
The publishable key (`sb_publishable_...`) and secret key (`sb_secret_...`, Project Settings → API Keys) are for Supabase Auth / PostgREST clients.
**9vercel does not use them for the DB** — the DB goes through `DATABASE_URL` (the `postgres` / postgres.js driver), not `@supabase/supabase-js`. For a DB-only deploy, `DATABASE_URL` alone is enough.
If you later add client-side Supabase Auth features, set (copied from your own dashboard):
```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
```

---

## 2) Env vars

### Local (`C:\laragon\www\9vercel\.env` or `.env.local`)
```env
# Empty DATABASE_URL → SQLite automatically (file in %APPDATA%/9router)
# Or fill it in to test Supabase locally (copy the Transaction pooler from the dashboard):
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true

JWT_SECRET=replace-with-min-32-char-random
INITIAL_PASSWORD=replace-with-dashboard-password
```
If `DATABASE_URL` is empty or still `[YOUR-PASSWORD]`, the app logs:
`[DB] DATABASE_URL contains placeholder — skipping Supabase, falling back to SQLite` and keeps running.

### Dashboard password (`INITIAL_PASSWORD` and the `123456` fallback)

Login resolution order (`src/lib/auth/dashboardSession.js` → `verifyDashboardPassword`):

1. If a password hash is stored in settings (i.e. you already changed the password via Dashboard → Profile/Settings), that hash wins — `INITIAL_PASSWORD` is ignored.
2. Otherwise the app compares against `INITIAL_PASSWORD` from env.
3. If `INITIAL_PASSWORD` is unset, it falls back to the upstream 9Router default **`123456`** (same as stock 9Router).

So on a fresh deploy without `INITIAL_PASSWORD`, just log in with `123456`, then change it in Dashboard → Profile/Settings. After the first change, the DB hash takes over and the env value no longer matters. On production you should still set `INITIAL_PASSWORD` in Vercel env so the very first login is never the public default.

> Live production already runs with env vars set — this only describes the fallback chain for fresh/public deploys.

### Vercel (Dashboard → Project → Settings → Environment Variables)
Required:

| Key | Value | Notes |
|-----|-------|-------|
| `DATABASE_URL` | `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true` | Pooling 6543 + `?pgbouncer=true`, user `postgres.<ref>` (copy the Transaction pooler from the dashboard). `POSTGRES_URL` alias also supported. |
| `JWT_SECRET` | long random (≥32 chars) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `INITIAL_PASSWORD` | dashboard login password | Used on first login before a password hash is stored in the DB; falls back to `123456` when unset (change it in Dashboard → Profile/Settings right after first login) |

Recommended:

| Key | Value | Notes |
|-----|-------|-------|
| `CRON_SECRET` | random hex 32 | Secures `/api/cron/refresh-tokens`. Generate: `openssl rand -hex 32` |
| `NINEROUTER_PEER_TOKEN` | random hex 24+ | Proves `x-9r-real-ip` is genuine for login rate-limiting. When empty, the `vercel-middleware` fallback is used. |

Also: do NOT set `DATA_DIR` on Vercel (self-host only).

> See `.env.example` in the repo for the full reference with per-var comments.

---

## 3) Deploy to Vercel

### Option A — via GitHub (recommended)
1. Push the `9vercel` repo to GitHub (private is fine).
2. Vercel Dashboard → **Add New Project → Import** that repo.
3. Framework preset: **Next.js** (auto-detected).
4. Set **Environment Variables** as in the table above (Production + Preview).
5. Deploy.

### Option B — via CLI
```bash
npm i -g vercel
cd C:/laragon/www/9vercel
vercel          # first-time linking
vercel --prod   # production deploy
vercel env add DATABASE_URL   # then paste the Transaction pooler 6543 value from the dashboard
vercel env add JWT_SECRET
vercel env add INITIAL_PASSWORD
vercel --prod   # redeploy so the env takes effect
```

### Build
- Local check: `npm run build` (verified — compiled successfully, 137 pages, postbuild standalone copy).
- Vercel builds with `npm run build` too; `next.config.mjs` automatically disables `output: standalone` when `VERCEL=1` so it doesn't clash with Vercel tracing. Verified: `VERCEL=1 npm run build` succeeds, `No standalone build found` (expected).
- **Pooler at build time:** the log `[DB] Driver: supabase-postgres | host: aws-0-<region>.pooler.supabase.com` means the env is picked up. If you still see `better-sqlite3` or `ENETUNREACH db.<ref>.supabase.co:5432`, `DATABASE_URL` is still the direct one — switch to the 6543 pooler.

---

## 4) Cron — OAuth token refresh

- File: `src/app/api/cron/refresh-tokens/route.js` (`GET`/`POST`, `maxDuration: 60`, fail-open).
- Schedule: `vercel.json` → `crons: [{ path: "/api/cron/refresh-tokens", schedule: "0 0 * * *" }]` (daily — Hobby allows daily only, `*/15` needs Pro).
- What it does: calls `runBackgroundTokenRefreshTick()` — refreshes OAuth tokens expiring within 30 minutes.
- Auth: `CRON_SECRET` is required — the handler checks `Authorization: Bearer <CRON_SECRET>` or `x-cron-secret`. Vercel Cron sends the Bearer token automatically when the secret is configured.
- **Important fix:** `src/dashboardGuard.js` already lists `/api/cron/refresh-tokens` in `PUBLIC_API_PATHS`. Without it, `dashboardGuard` returns 401 before the handler can check `CRON_SECRET` — cron would never return 200 even with the right secret.
- Verify:
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/cron/refresh-tokens
  # expect: {"ok":true,"elapsedMs":...}
  curl https://<project>.vercel.app/api/cron/refresh-tokens
  # expect: 401 Unauthorized
  ```

Locally/self-hosted the scheduler keeps running via `custom-server.js` + `initializeApp` (5-minute `setInterval`) — no cron needed.

---

## 5) Real IP & rate-limit on Vercel

- Self-host: `custom-server.js` stamps `x-9r-real-ip` from the TCP socket + `x-9r-peer-token` (per-process secret).
- Vercel: `src/proxy.js` (Next `proxy`, formerly `middleware`) stamps `x-9r-real-ip` from `x-forwarded-for` (Vercel Edge) + `request.ip` fallback, then forwards to `dashboardGuard`.
- `src/lib/auth/trustedPeer.js` trusts the header if `x-9r-peer-token === NINEROUTER_PEER_TOKEN` or (`VERCEL=1` and token `vercel-middleware`). This prevents `x-9r-real-ip` spoofing to bypass `loginLimiter`.

No need to set `TRUST_PROXY`.

---

## 6) Verify after deploy

1. Open `https://<project>.vercel.app/login` → log in with `INITIAL_PASSWORD` (or `123456` on a fresh deploy without it, then change it in Dashboard → Profile/Settings) → dashboard should load.
2. Check the Vercel logs (Deployments → Logs): you must see `[DB] Driver: supabase-postgres | host: aws-0-<region>.pooler.supabase.com` (not `better-sqlite3`). If you still see `better-sqlite3`, `DATABASE_URL` isn't applied / is still a placeholder.
3. API test: `curl https://<project>.vercel.app/api/health` and `POST /api/auth/login`.
4. Trigger cron manually (secret required): `curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/cron/refresh-tokens` → `{"ok":true,...}`
5. In Supabase Dashboard → Table Editor → check `providerConnections`, `settings`, etc. fill up after you add a provider. Write test: `POST /api/combos` then `GET /api/combos` must persist (Supabase pooler, not ephemeral SQLite).

A healthy deploy looks like:
- Logs show `[DB] Driver: supabase-postgres | host: aws-0-<region>.pooler.supabase.com`
- Supabase Dashboard → Table Editor → `providerConnections`, `combos`, etc. fill up as you add data

---

## 7) Troubleshooting

| Symptom | Cause | Fix |
|--------|-------|-----|
| Build succeeds but log says `[DB] DATABASE_URL contains placeholder` | Env still has `[YOUR-PASSWORD]` | Paste the real password, redeploy |
| `password authentication failed` | Wrong password / wrong user (`postgres` instead of `postgres.<ref>` for the pooler) | Use `postgres.<ref>` for the pooler; reset the password in Supabase |
| `ENOTFOUND aws-0-...pooler.supabase.com` | Wrong pooler region | Copy the exact host from your project's Project Settings → Database |
| `ENETUNREACH db.<ref>.supabase.co:5432` in the Vercel build | Direct 5432 doesn't work on serverless IPv6 | Switch to the `6543?pgbouncer=true` pooler |
| `too many clients` / `max_connections` | Port 5432 without pgbouncer | Same fix: Transaction pooler 6543 |
| Cron always 401 even with the right `CRON_SECRET` | `dashboardGuard` blocking before the handler (old bug) | Already fixed — make sure you're on the latest deploy; then retest with the Bearer curl above |
| Cron never runs at all | Non-daily schedule on Hobby | Keep `0 0 * * *` (daily); sub-daily needs Pro |
| First login doesn't work | Forgot whether `INITIAL_PASSWORD` was set | Try `123456` (default fallback); check `INITIAL_PASSWORD` in Vercel env |
| Login rate-limit bypass warning | `NINEROUTER_PEER_TOKEN` not set | Set it in Vercel env (optional, a fallback exists but is less strict) |
| Local Windows warning `DATA_DIR '/var/lib/9router' is a Unix path` | Linux-style `.env` copied to Windows | Unset `DATA_DIR` locally or set a valid Windows path; auto-falls back to `%APPDATA%/9router` |

---

## 8) Files changed for Vercel

- `src/lib/db/adapters/supabaseAdapter.js` — new, translates `?→$n`, `INSERT OR REPLACE→ON CONFLICT`, camelCase normalization
- `src/lib/db/driver.js` — auto-switch Supabase-first, `wrapAsync` always-async, placeholder guard, `global._supabaseSql` reuse
- `supabase/schema.sql` — Postgres DDL (IF NOT EXISTS, unquoted identifiers + normalize)
- `src/proxy.js` — stamps `x-9r-real-ip` for Vercel (merged with dashboardGuard)
- `src/dashboardGuard.js` — added `/api/cron/refresh-tokens` to `PUBLIC_API_PATHS` so `CRON_SECRET` can pass
- `src/lib/auth/trustedPeer.js` — trusts the Vercel middleware fallback
- `src/shared/services/initializeApp.js` — skips cloudflared/MITM on `VERCEL=1`, cron replaces the interval
- `src/app/api/cron/refresh-tokens/route.js` — new (`GET`/`POST`, checks `Bearer`/`x-cron-secret`, fail-open)
- `vercel.json` — crons `0 0 * * *` (daily Hobby) + `maxDuration: 60`
- `next.config.mjs` — `output: standalone` disabled when `VERCEL=1`
- `package.json` — added `postgres@^3.4.9`
- `.env.example` — Supabase/Vercel env documentation
- `src/lib/db/**` — all repos/helpers/migrate/index async-ified for Postgres
