# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Router (`9router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `9router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `9router`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

**Deploy-fork status (this repo's focus):** this is the Vercel-deploy fork. It tracks upstream [`decolua/9router`](https://github.com/decolua/9router) at **v0.5.81** (port branch `port/upstream-0.5.81`), plus two unmerged upstream fixes backported here — OpenCode free-tier fingerprint quartet (upstream PR #4188, fixes 403 `FreeTierError`) and usage reporting on `response.completed` for Codex auto-compact (upstream PR #4192) — plus MIBP backports (`freebuff` provider + device-code login wiring, `cline-free`, test `DATA_DIR` isolation). Primary target is **Vercel + Supabase Postgres**; local dev stays zero-config SQLite. Full walkthrough: `DEPLOY_VERCEL.md` (EN) / `DEPLOY_VERCEL_ID.md` (ID), condensed path in `README.md` §Vercel + Supabase Deployment.

## Deploy contract (Vercel + Supabase) — read first

- **Database.** `DATABASE_URL` (aliases `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` / `SUPABASE_DB_URL` / `SUPABASE_DATABASE_URL`) must be the Supabase **Transaction Pooler** (`:6543?pgbouncer=true`, user `postgres.<ref>`, host copied from the project's own dashboard). Direct `:5432` hits IPv6 `ENETUNREACH` on serverless and exhausts `max_connections` without pgbouncer. A value still containing `[YOUR-PASSWORD]` is treated as placeholder — the app logs a warning and falls back to SQLite (ephemeral: data lost on recycle). Schema: run `supabase/schema.sql` once in the SQL Editor (idempotent, 11 tables + `settings(id=1)` seed); migration `001-initial` self-heals at boot if skipped. NOTE: never commit live project refs, hosts, URLs, passwords, or keys — docs use `<ref>`/`<region>` placeholders.
- **Required env on Vercel.** `JWT_SECRET` (boot throws without it — stateless instances need one stable value or sessions fail across instances / login loops), `INITIAL_PASSWORD` (falls back to upstream default `123456` when unset — log in, then change in Dashboard → Profile/Settings). Recommended: `CRON_SECRET` (secures `/api/cron/refresh-tokens`), `NINEROUTER_PEER_TOKEN` (authenticates `x-9r-real-ip` for login rate-limit). Do NOT set `DATA_DIR` on Vercel. Full contract in `.env.example` (+ README env table).
- **Build/output.** `next.config.mjs` disables `output: standalone` when `VERCEL=1` (Vercel handles its own tracing/output); `serverExternalPackages` keeps `better-sqlite3`, `sql.js`, `node:sqlite`, `bun:sqlite`, `open` external. `vercel.json` schedules `GET /api/cron/refresh-tokens` daily (`0 0 * * *` — Hobby limit), `maxDuration: 60`, fail-open via `runBackgroundTokenRefreshTick()`. The cron path is whitelisted in `src/dashboardGuard.js` `PUBLIC_API_PATHS` so the guard doesn't 401 before the handler checks `CRON_SECRET` (send `Authorization: Bearer <CRON_SECRET>` or `x-cron-secret`; Vercel Cron attaches it automatically). Local/self-host needs no cron — `custom-server.js` + `initializeApp` run the same refresh on a 5-minute interval (skipped when `VERCEL=1`).
- **Ephemeral filesystem.** `DATA_DIR` falls back to `/tmp/.9router` on Vercel with EROFS/ENOSPC handling (`src/lib/dataDir.js`, `src/lib/db/paths.js`); catalog-FS, mitm logger/alias-cache fail-open. Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.
- **IP / rate-limit.** `custom-server.js` stamps `x-9r-real-ip` from the TCP socket (per-process peer token) and strips spoofable forwarding headers; `src/proxy.js` + `trustedPeer.js` provide the Vercel fallback. Preserve this when touching request/IP/rate-limit code.
- **Model self-test** (`POST /api/models/test` + `POST /api/providers/[id]/test-models` → `pingModelByKind` in `src/app/api/models/test/ping.js`) probes through the public app URL (`new URL(request.url).origin`) on `VERCEL=1`, loopback `http://127.0.0.1:${PORT||20128}` otherwise. `ping.js` `postProbe` catches fetch throws into `{ ok:false }` (never throws), and `/api/models/test` returns 200 on unexpected errors — probe failures are expected results, not 500s. `/api/pxpipe/restart` returns 409 `NOT_INSTALLED` (not 500) when the package is missing, mirroring `/api/pxpipe/start`. Any rework must keep self-probes off loopback on Vercel (absolute app URL or in-process handler call; `isLoopbackHostname`/SSRF guards still treat 127.0.0.1 as loopback) and must return probe failures as `{ ok:false }`, not 500s.
- **Verify after deploy:** `/api/health`, login POST, combos survive redeploy (rows in Supabase `providerConnections`/`combos`), `/v1/models` + `/v1/chat/completions` with a dashboard API key, cron 401-without-secret / ok-with-secret. Symptom→fix matrix: `DEPLOY_VERCEL.md` §7–§8.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # code default port is 20127 (root package.json dev); docs/prod standardize on 20128 — always set PORT explicitly
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Dashboard at `/dashboard`, API at `/v1`. `npm run build` green is the gate before any deploy/port.
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```
- `sql.js`/`better-sqlite3` and `systray2` are NOT bundled — lazy-installed into `~/.9router/runtime` by `hooks/postinstall.js` (avoids Windows `EBUSY` on global update + AV false positives on unsigned Go binaries).

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `npm test`):
```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> The committed `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — a shared-install workaround from upstream. On Windows (or anywhere), ignore it and use the `npx vitest` form above; `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **The suite is NOT expected to be all-green on a plain checkout.** Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run — counts drift, source of truth is `tests/__baseline__/known-fails.txt` + `baseline-results.json`. Currently expected red includes:
> - entries in `known-fails.txt` (rtk, oauth-cursor-auto-import, translator-request-normalization, …).
> - `unit/embeddings.cloud.test.js` imports `cloud/src/handlers/embeddings.js` — the `cloud/` worker dir is **not in this repo**, so it always fails here.
> - `unit/xai-oauth-service.test.js` times out (5s) when the xAI endpoint-discovery fetch isn't reachable/mocked.
> - `real/*.real.test.js` + `translator/real/*.real.test.js` make live provider calls — need credentials, skip otherwise.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.
- `verify-no-regression.mjs` needs `<results.json>`: run `npx vitest run --reporter=json --outputFile=<path>` from `tests/`, then `node tests/__baseline__/verify-no-regression.mjs <path>` **from repo root** (paths in `known-fails.txt` are repo-relative `tests/...`; running the script from `tests/` breaks its `tests/__baseline__/` resolution). JSON reporter paths are OS-specific — normalize `\\` → `/` and strip to `tests/...` before comparing (the committed script does exact `f.name.split("/app/")[1]` matching, which never matches Windows/Unix vitest output).
- Runs must happen with cwd `tests/` (config resolves `open-sse`/`@/` aliases from repo root itself). A temp worktree needs its own `tests/node_modules` (`npm install` inside `tests/`) or the config fails with `Could not resolve 'vitest/config'`. Full run takes ~60s; expect snapshot churn — delete local `tests/translator/__snapshots__/golden-url-header.test.js.snap` artifacts before committing (not from upstream).
- Test isolation: `vitest.config.js` `setupFiles` loads `tests/setup/isolateDataDir.js`, which redirects `DATA_DIR` to a tmp dir so the suite never writes the real `~/.9router` (some route-handler tests call `createProviderConnection`). Escape hatches: `RUN_REAL=1` keeps the real dir for `*.real.test.js`, `DATA_DIR=<path>` respects an explicit override. Covered by `unit/test-data-dir-isolation.test.js` — do NOT delete that file or drop it from `setupFiles`.
- `unit/db-concurrent.test.js`, `unit/db-migration-chain.test.js`, `unit/request-details-tab.test.js` call the DB layer **without `await`** (`db.get(...)`, `db.run(...)`, `db.all(...)`) because they were written against upstream's sync better-sqlite3 adapter. Our `driver.js` `wrapAsync` makes those return Promises — so `row.value` is `undefined`, `.map` is not a function, and parallel races lose on `BEGIN`-serialized SQLite. They fail on clean `main` too (pre-existing fork debt, not a port regression). Do NOT "fix" by touching `driver.js` alone — that changes the Supabase contract; the real fix is awaiting those calls or adding a sync test-only path.
- Upstream's own suite is red too: pure `v0.5.65` fails here, including `openai-to-kiro` / `claude-kiro-direct` thinking-budget cases (commit `1fc2a81` removed the top-level `systemPrompt` the old tests still assert). When judging a port, diff failure sets: `base fails` vs `port fails` vs `pure-upstream fails` — port-only-but-not-base-only is the regression signal, not the raw count.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.
- This fork adds a **Supabase Postgres adapter** (`src/lib/db/adapters/supabaseAdapter.js`, driver `postgres`/`postgres.js`) that auto-wins when `DATABASE_URL` (or `POSTGRES_URL*`/`SUPABASE_*`) is set and non-placeholder. Because Postgres is inherently async, `driver.js` `wrapAsync` normalizes **all** adapters to always-async (`await db.get/run/all`, `await db.transaction(async () => ...)`), and every repo/helper/migrate was async-ified. **Upstream is still sync** (`db.transaction(() => ...)` on raw better-sqlite3) — any upstream DB code (notably `src/lib/db/repos/aliasRepo.js` `addCustomModel`) must be re-asyncified on port, never copied verbatim; keep the `// Fork note:` comments marking such spots.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/dataDir.js` (`DATA_DIR` → platform default, Unix-style `DATA_DIR` on Windows warns + falls back, Vercel → `/tmp/.9router`) + `src/lib/db/paths.js` (`$DATA_DIR/db/data.sqlite`). See Deploy contract above for the Vercel/Supabase behavior.
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code (Vercel details: see Deploy contract above).
- Security-sensitive env: `JWT_SECRET` (session cookie, required on Vercel), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`, plus `AUTH_COOKIE_SECURE`, `REQUIRE_API_KEY`, proxy vars, `SEARXNG_URL`. Full contract in `.env.example` (+ README env table) — reference it, don't duplicate the table here.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- **Security-first on PRs**: Security is the top priority when reviewing or creating PRs. Audit authentication, credential/token storage & leaks, header manipulation (`X-Forwarded-For`), and SSRF risks before functional logic. Always include explicit security warnings/notes when reporting PR reviews or changes to the user.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).
- Upstream porting (this fork tracks `decolua/9router`, npm `9router`; ported through `v0.5.81` on branch `port/upstream-0.5.81`, one commit per version 0.5.69/0.5.75/0.5.81): the fork root has **no common ancestor** with upstream, so `merge` refuses (`unrelated histories`) — port via `git checkout vX.Y.Z -- <paths>` selective checkout, hand-merging the overlap files (`src/dashboardGuard.js`, `src/lib/db/repos/aliasRepo.js`, `src/shared/hooks/useModelCaps.js`, `.gitignore`, `package.json`, `Dockerfile`, `cli/package.json`, plus `open-sse/translator/request/openai-responses.js`, `dashboard/profile/page.js`, `nonStreamingHandler.js`, `api/models/test/ping.js`, `api/v1/models/route.js`, `auth/dashboardSession.js`, `db/repos/connectionsRepo.js`, `lib/db/driver.js`, `lib/modelCatalog/sync.js`, `executors/opencode.js`, `shared/components/Sidebar.js`, `sse/services/auth.js`). `cherry-pick -n` of a range replays the sync-DB commits against the async fork and conflicts immediately — don't. Known hand-merges to preserve: `/responses` in `PUBLIC_PREFIXES` + `/api/cron/refresh-tokens` in `PUBLIC_API_PATHS` (both), caps-upsert in `addCustomModel` re-asyncified, fork object-guard + upstream `customModelChanged` listener in `useModelCaps`, `postgres` dep kept across version bumps, fork `result.stream` carry + `stream !== false` in `openai-responses.js`, `IS_VERCEL_UI` shutdown-hide + upstream `isRemoteHost` label in profile, health-reset (`resetHealthStateOnActivation`) re-applied in async style in `connectionsRepo.js`, upstream `routableQoderModels`/`resolveClineModels` wired through fork lazy imports in `v1/models/route.js`, upstream Node ≥24 better-sqlite3 skip kept alongside fork Supabase-first `driver.js`, Vercel guard kept next to upstream `fileVersion` reset in `sync.js`, fork muse-spark 1024 output floor kept in `opencode.js`. Merge mechanics that work: `git merge-file` on LF-normalized temp copies (worktree is CRLF via `core.autocrlf`, blobs are LF — merging in place corrupts endings); `package.json` is version-bump-only, never bulk-checkout it.
- Port-gate convention (established 0.5.69→0.5.81): after each version, `npm run build` green + full vitest fail-set diffed against the `v0.5.65` baseline — signal is port-only new fails. Known upstream-stale fails left red, never "fixed" by weakening the port: `unit/kiro-external-idp.test.js` endpoint ordering (upstream reordered to `q.*` first, never updated the test), and `it.fails` bug-exposure tests flip to `it` when the ported fix resolves them (image-preservation cases flipped at 0.5.81, CommandCode `mediaType` expectations updated, CommandCode error-throw re-asserted).
- Fork-only Vercel hardening to preserve on every port: see Deploy contract above (`DATA_DIR` fallback + EROFS/ENOSPC handling, mitm logger/alias-cache fail-open, catalog-FS fail-open, object-shaped combo-model guards incl. `useModelCaps` guard, `x-9r-real-ip` stamping + `trustedPeer.js` fallback, daily cron, `output: standalone` off on `VERCEL=1`, self-probe + `{ok:false}` contract).
