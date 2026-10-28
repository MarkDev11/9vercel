# AGENTS.md

9Router (`9router-app`) — Next.js dashboard + OpenAI-compatible gateway (`/v1/*`) routing to 40+ providers. This fork's whole point is the **Vercel + Supabase Postgres deploy**; upstream is SQLite-only. Ported through upstream **`v0.5.111`** (tags `v0.5.104`/`v0.5.109`/`v0.5.111`, one commit/port per version, on `main`).

## Layout

- `src/app/api/v1/*` + `src/sse/` — app glue (combo expansion, account loop). `open-sse/` — provider-agnostic engine (translate → execute → stream). Cross that boundary consciously.
- `cli/` — separate npm package `9router` (own version/build). `tests/` — independent ESM vitest package, not wired to root scripts.
- Read before editing: `CLAUDE.md` (full fork notes + deploy contract), `open-sse/AGENTS.md` (engine), `tests/translator/AGENTS.md` (translator tests), `docs/ARCHITECTURE.md` (lifecycle), `DEPLOY_VERCEL.md` / `DEPLOY_VERCEL_ID.md` (serverless), `.env.example` (env contract; comments in Bahasa).

## Commands (root)

```bash
cp .env.example .env; npm install
npm run dev      # pins --port 20127 (script passes the flag; flag wins over PORT env)
npm run build    # = next build --webpack + postbuild copy-standalone-assets.mjs; keep --webpack
npm run start    # custom-server.js → argv → next start, so also pinned to 20127
npx next dev --port 20128  # to bind another port, pass --port yourself (PORT env only applies without a flag)
npx eslint .     # red at baseline (~277 errors, ~410 warnings); config eslint.config.mjs — compare counts, don't chase zero
npm run cli:pack # build+pack CLI from root (.tgz lands in repo root, gitignored via 9router-*)
```

- Dashboard `/dashboard`, API `/v1` (rewritten to `/api/v1/*` in `next.config.mjs`; `/responses`, `/codex`, `/v1beta`, `/systemone` too), plus `/v1/videos/*` (video-gen adapters). Docs / self-probe default port **20128**.
- `next.config.mjs` disables `output: standalone` when `VERCEL=1`; `serverExternalPackages` must keep `open` + sqlite drivers. `vercel.json` cron is daily `0 0 * * *` only (Hobby limit), `maxDuration: 60`, region `hnd1`.
- No `opencode.json`; no root test/typecheck script. Path aliases (`jsconfig.json`): `@/*` → `src/*`, `open-sse` → `./open-sse`.

## Deploy (Vercel-first) — non-negotiables

- Supabase **Transaction Pooler** `:6543?pgbouncer=true`, user `postgres.<ref>` — direct `:5432` fails on serverless (`ENETUNREACH`, max_connections). Placeholder `DATABASE_URL` (contains `[YOUR-PASSWORD]`) falls back to SQLite (ephemeral).
- `JWT_SECRET` fail-fasts on Vercel; `INITIAL_PASSWORD` defaults to `123456`; dashboard cookie `maxAge` 24h. **Never commit live refs/hosts/passwords/keys — use `<ref>`/`<region>` placeholders** (as done everywhere in the docs).
- Never set `DATA_DIR` on Vercel (falls back to `/tmp/.9router` with EROFS/ENOSPC handling). Smoke after deploy: `/api/health`, login, `POST→GET→DELETE /api/combos`, cron 401-without-secret / `{"ok":true}`-with-secret.
- **Postgres schema drift**: `CREATE TABLE IF NOT EXISTS` never adds a column to an existing table, so `migrate.js` diffs Postgres columns via `information_schema` and runs `ALTER TABLE ... ADD COLUMN` (additive only). If you add a column to `src/lib/db/schema.js`, also add it to `supabase/schema.sql` **and** an idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` there — otherwise a deployed Supabase project breaks with "column does not exist".
- **Postgres identifier casing**: unquoted identifiers fold to lower case, so the table created as `apiKeys` is really `apikeys` with columns `accessrestricted`/`accessallow`. Any `information_schema` lookup must use `lower(table_name)` (and pin `table_schema = 'public'`), and column comparisons must be case-insensitive on **both** engines — otherwise every column looks missing and the sync fires ~70 failing ALTERs per cold start (adapter ready 12s instead of ~200ms).
- `supabase/schema.sql` must stay in sync with `src/lib/db/schema.js` (11 tables, `_meta` included); it is applied once in the Supabase SQL Editor.

## Tests (`tests/`)

```bash
npm install            # root first — tests import src/ deps (open, undici)
cd tests && npm install  # vitest lives here; cwd MUST be tests/ (config resolves root aliases)
npx vitest run                          # full (~60s)
npx vitest run unit/capabilities.test.js  # single file (path relative to tests/) — or plain `npm test` inside tests/
```

- Suite is **red at baseline** — full run at `v0.5.111`: **~4144 passed / ~46 failed** (45 of 1300 suites; pristine upstream fails 33). Counts wobble by ±1-2 between runs (a few DB-pollution/network flakes), so judge regressions by diffing fail-sets (base vs port vs your change — port-only-but-not-base-only is the signal), never raw counts. `tests/__baseline__/known-fails.txt` is v0.5.65-era and drifted (lists rtk fails that now pass) — capture fresh runs, don't trust it.
- Fork-only reds (fail on the fork, pass on pristine upstream): `translator/golden-request` (snapshot), `unit/dashboard-guard` + `unit/db-migration-chain` + `unit/db-concurrent` + `unit/db-sqlite-vs-lowdb` (async `await`-debt from the fork's always-async DB), `unit/key-access-handlers` (passes standalone; flaky under full-run DB pollution). `unit/golden-url-header` snapshots are stale on upstream too — leave red, delete the local `.snap` before committing.
- Upstream-stale fails left red on purpose (verified failing on pristine upstream too): `unit/kiro-external-idp.test.js` endpoint ordering, GLM-5.2 reasoning_effort caps (`translator/thinking-unified`), the kiro thinking-budget family (`claude-kiro-direct`/`openai-to-kiro`), cline paid-twin pricing, gpt-6.1-sol caps, codex token-rotation lead, `unit/codebuddy-block-backoff`, `unit/combo-credit-fallback`, `unit/headroom-responses-format`, `unit/zed-native-auth`, `unit/embeddings.cloud` (imports the `cloud/` dir that is not in this repo). Other baseline debt: `security-audit.test.js` (source-regex checks), Windows/network flakes (`codex-image-fetch` 1MB remote fetch, `xai-oauth` discovery timeout, live `*.real.test.js` need creds and run only via `RUN_REAL=1`).
- `it.fails` = known bug OR intentional fork divergence (e.g. codebuddy-intl probe) — it flips red (shows as FAIL) when the divergence resolves; then flip it to `it` and verify.
- Translator tests MUST `import "./registerAll.js"` (ESM `require` no-op → false pass).
- `tests/setup/isolateDataDir.js` (wired via `setupFiles` in `vitest.config.js`) redirects `DATA_DIR` to a temp dir — never remove it, or route-level tests write junk rows into the live `~/.9router` DB. Escape hatches: `RUN_REAL=1`, explicit `DATA_DIR`.
- Snapshot churn: delete local `tests/translator/__snapshots__/golden-url-header.test.js.snap` before commit (it is untracked). JSON reporter paths are OS-specific — normalize `\` → `/`.

## Upstream porting (fork has no common ancestor with upstream)

- Never `merge`/`cherry-pick` — port via `git checkout vX.Y.Z -- <paths>` selective checkout, one version per commit. `package.json` is version-bump-only: bump by hand, never bulk-checkout (keeps `postgres` dep).
- Overlap files need `git merge-file` on **LF-normalized temp copies** (worktree is CRLF via `core.autocrlf`, blobs are LF — merging in place corrupts endings); write back as CRLF. **Do not trust merge-file exit codes** (2/3/4 observed on successful merges) — decide by marker scan (`^<{7}|^>{7}`), and re-extract + merge once if markers look nested (double-merge artifact). Per-version overlap list: `git diff --name-only vOLD..vNEW` ∩ fork files. New registry providers consume `pNNN` slots — renumber fork entries (freebuff is now `p153`; upstream numbering wins) and verify no duplicate identifiers + count via import.
- Port gate per version: `npm run build` green + full vitest fail-set diffed vs the previous baseline.

## Request flow

`/v1/*` rewrite → `src/app/api/v1/*` → `src/sse/handlers/chat.js` (parse, combo/account loop) → `open-sse/handlers/chatCore.js` (detect format, RTK/headroom/caveman pre-hooks, `getExecutor`, `translateRequest/Response`) → `open-sse/executors/*` → SSE out. Aborts after HTTP 200 are reported in-band (per-format error frames), not silent closes; CommandCode mid-stream errors throw so fallback triggers.

## open-sse conventions

- Pivots through **OpenAI as intermediate**; exact `source:target` pair = direct route (prefer for thinking blocks, tool ids, non-base64 images, `is_error`). Translators self-register via `register()` side effect — new file MUST be imported in `translator/index.js`.
- Never hardcode roles/blocks/models — use `config/` + `translator/schema/`. New provider: copy `providers/REGISTRY_TEMPLATE.js` → `providers/registry/{id}.js` + models in `config/providerModels.js`; `registry/index.js` is auto-generated (use `scripts/migrate-registry.mjs`, don't hand-edit). Only non-OpenAI-compatible upstreams need an executor (`BaseExecutor` subclass, register in `executors/index.js`); binary upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) live in their executor, never the translator. CommandCode image blocks carry both `mediaType` and `mimeType`.
- `rtk/` + headroom/caveman mutate in place and are **fail-open** — never throw; RTK skips `is_error` results. Qoder image uploads go to Qoder's own cloud endpoint, not local disk.
- Freebuff (`fb`, ported from MIBP fork): OAuth device-flow via freebuff.com, chat on www.codebuff.com; executor claims a per-(token,model) session + registers a run per request. One session is locked to one model (409 `model_locked`) — advise separate accounts per model. Quota reads are GET-only (POST would burn a session).

## DB — async fork, upstream is sync

- `src/lib/db/driver.js` order: Supabase (if `DATABASE_URL`|`POSTGRES_URL*`|`SUPABASE_*` set, non-`[YOUR-PASSWORD]`) → `bun:sqlite` → `better-sqlite3` (optional; skipped on Node ≥24 — native addon SIGSEGVs) → `node:sqlite` (≥22.5) → `sql.js`. Always `await db.get/run/all` and `await db.transaction(async () => ...)`.
- Never copy upstream DB code verbatim — re-asyncify it, keep `// Fork note:` comments. New code imports `@/lib/db/index.js` (`src/lib/localDb.js` is a shim); logic in `repos/*`, schema in `migrations/`. Local dev needs zero DB config (SQLite via `src/lib/db/paths.js`: `DATA_DIR` else `~/.9router/`).
- `usageDb.js` is only a shim — usage/logs now live in the same SQLite DB (`db/data.sqlite`), not in `~/.9router/usage.json`.

## Gotchas to preserve

- `custom-server.js` derives client IP from TCP socket, strips `X-Forwarded-For`/`x-9r-real-ip`, stamps `x-9r-peer-token` — preserve when touching IP/rate-limit/proxy code. Self-probes (`POST /api/models/test`, `pingModelByKind`) use absolute app URL on `VERCEL=1`, loopback otherwise; probe failures return `{ ok:false }` / 200, never 500 (`/api/pxpipe/restart` 409 `NOT_INSTALLED` when missing).
- `v1/models` resolvers are fork-lazy (`await import` for cold start) — wire new upstream resolvers (`routableQoderModels`, `resolveClineModels`, …) through lazy imports, never static ones.
- JS ESM only, no TS. Conventional Commits (`fix(translator): …`); root and `cli/` versioned independently, log in `CHANGELOG.md`.
