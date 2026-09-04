# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Router (`9router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `9router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `9router`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `npm test`):
```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> The committed `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — a shared-install workaround from upstream. On Windows (or anywhere), ignore it and use the `npx vitest` form above; `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **The suite is NOT expected to be all-green on a plain checkout.** ~938 pass, ~64 fail. Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run. Expected red:
> - 26 catalogued in `tests/__baseline__/known-fails.txt` (rtk, oauth-cursor-auto-import, translator-request-normalization, …).
> - `unit/embeddings.cloud.test.js` imports `cloud/src/handlers/embeddings.js` — the `cloud/` worker dir is **not in this repo**, so it always fails here.
> - `unit/xai-oauth-service.test.js` times out (5s) when the xAI endpoint-discovery fetch isn't reachable/mocked.
> - `real/*.real.test.js` make live provider calls — need credentials, skip otherwise.
- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.
- `verify-no-regression.mjs` needs `<results.json>`: run `npx vitest run --reporter=json --outputFile=<path>` from `tests/`, then `node tests/__baseline__/verify-no-regression.mjs <path>` **from repo root** (paths in `known-fails.txt` are repo-relative `tests/...`; running the script from `tests/` breaks its `tests/__baseline__/` resolution). JSON reporter paths are OS-specific — normalize `\\` → `/` and strip to `tests/...` before comparing (the committed script does exact `f.name.split("/app/")[1]` matching, which never matches Windows/Unix vitest output).
- Vitest is config-fragile outside `tests/`: runs must happen with cwd `tests/` (config resolves `open-sse`/`@/` aliases from repo root itself). A temp worktree needs its own `tests/node_modules` (`npm install` inside `tests/`) or the config fails with `Could not resolve 'vitest/config'`. Full run takes ~60s; expect `Snapshots 124 written` churn — delete local `tests/translator/__snapshots__/golden-url-header.test.js.snap` artifacts before committing (not from upstream).
- `unit/db-concurrent.test.js`, `unit/db-migration-chain.test.js`, `unit/request-details-tab.test.js` call the DB layer **without `await`** (`db.get(...)`, `db.run(...)`, `db.all(...)`) because they were written against upstream's sync better-sqlite3 adapter. Our `driver.js` `wrapAsync` makes those return Promises — so `row.value` is `undefined`, `.map` is not a function, and parallel races lose on `BEGIN`-serialized SQLite. They fail on clean `main` too (pre-existing fork debt, not a port regression). Do NOT "fix" by touching `driver.js` alone — that changes the Supabase contract; the real fix is awaiting those calls or adding a sync test-only path.
- Upstream's own suite is red too: pure `v0.5.65` fails 117 tests here, including all 28 `openai-to-kiro` / `claude-kiro-direct` thinking-budget cases (commit `1fc2a81` removed the top-level `systemPrompt` the old tests still assert). When judging a port, diff failure sets: `base fails` vs `port fails` vs `pure-upstream fails` — port-only-but-not-base-only is the regression signal, not the raw count.

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
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`).
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.
- Vercel deploy contract (see `DEPLOY_VERCEL.md`): `DATABASE_URL` must be the Supabase **Transaction Pooler** (`:6543?pgbouncer=true`, user `postgres.<ref>`, host copied from the project's own dashboard) — direct `:5432` hits IPv6 `ENETUNREACH` on serverless. NOTE: never commit live project refs, hosts, URLs, passwords, or keys to the repo — docs use `<ref>`/`<region>` placeholders.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).
- Upstream porting (this fork tracks `decolua/9router`, npm `9router`; ported through `v0.5.65` on branch `port/upstream-0.5.65`): the fork root has **no common ancestor** with upstream, so `merge` refuses (`unrelated histories`) — port via `git checkout vX.Y.Z -- <paths>` selective checkout, hand-merging the overlap files (`src/dashboardGuard.js`, `src/lib/db/repos/aliasRepo.js`, `src/shared/hooks/useModelCaps.js`, `.gitignore`, `package.json`, `Dockerfile`, `cli/package.json`). `cherry-pick -n` of a range replays the sync-DB commits against the async fork and conflicts immediately — don't. Known hand-merges to preserve: `/responses` in `PUBLIC_PREFIXES` + `/api/cron/refresh-tokens` in `PUBLIC_API_PATHS` (both), caps-upsert in `addCustomModel` re-asyncified, fork object-guard + upstream `customModelChanged` listener in `useModelCaps`, `0.5.65` version with `postgres` dep kept.
- Fork-only Vercel hardening to preserve on every port: `DATA_DIR` `/tmp/.9router` fallback + EROFS/ENOSPC handling (`src/lib/dataDir.js`, `src/lib/db/paths.js`), mitm logger/alias-cache fail-open (`be3d9b9`, `f15e59f`), catalog-FS fail-open (`ef91d6e`), object-shaped combo-model guards (`95a075c`, plus `useModelCaps` guard), `src/proxy.js` `x-9r-real-ip` stamping + `trustedPeer.js` Vercel fallback, `vercel.json` daily cron, `output: standalone` disabled on `VERCEL=1`.
- Model self-test (`POST /api/models/test` + `POST /api/providers/[id]/test-models` → `pingModelByKind` in `src/app/api/models/test/ping.js`) probes through the public app URL (`new URL(request.url).origin`) on `VERCEL=1`, loopback `http://127.0.0.1:${PORT||20128}` otherwise. `ping.js` `postProbe` catches fetch throws into `{ ok:false }` (never throws), and `/api/models/test` returns 200 on unexpected errors — probe failures are expected results, not 500s. `/api/pxpipe/restart` returns 409 `NOT_INSTALLED` (not 500) when the package is missing, mirroring `/api/pxpipe/start`. Any rework must keep self-probes off loopback on Vercel (absolute app URL or in-process handler call; `isLoopbackHostname`/SSRF guards still treat 127.0.0.1 as loopback) and must return probe failures as `{ ok:false }`, not 500s.
