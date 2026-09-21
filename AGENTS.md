# AGENTS.md

9Router (`9router-app`) — Next.js dashboard + OpenAI-compatible gateway (`/v1/*`) routing to 40+ providers. This Vercel fork adds Supabase Postgres; upstream is SQLite-only. Currently at upstream **`v0.5.81`** (port branch `port/upstream-0.5.81`, one commit per version).

## Layout

- `src/app/api/v1/*` + `src/sse/` — app glue (combo expansion, account loop). `open-sse/` — provider-agnostic engine (translate → execute → stream). Cross that boundary consciously.
- `cli/` — separate npm package `9router` (own version/build). `tests/` — independent ESM vitest package, not wired to root scripts.
- Read before editing: `CLAUDE.md` (full fork notes), `open-sse/AGENTS.md` (engine), `tests/translator/AGENTS.md` (translator tests), `docs/ARCHITECTURE.md` (lifecycle), `DEPLOY_VERCEL.md` (serverless contract), `.env.example` (env contract).

## Commands (root)

```bash
cp .env.example .env; npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev  # note: script defaults to 20127 without PORT
npm run build   # = next build --webpack + postbuild copy-standalone-assets.mjs; keep --webpack
npm run start   # runs custom-server.js with --port 20127 (flag wins over PORT env)
npx eslint .    # config eslint.config.mjs; suite is red at baseline (~270 errors) — compare counts, don't chase zero
npm run cli:pack  # build+pack CLI from root (.tgz lands in repo root, gitignored via 9router-*)
```

- Dashboard `/dashboard`, API `/v1` (rewritten to `/api/v1/*` in `next.config.mjs`) plus `/v1/videos/*` (OpenRouter/Vertex Veo via provider adapters). Runtime ports: dev default **20127**, documented prod **20128**.
- `next.config.mjs` disables `output: standalone` when `VERCEL=1`; `serverExternalPackages` must keep `open` + sqlite drivers. `vercel.json` cron is daily `0 0 * * *` only (Hobby limit), `maxDuration: 60`.
- No `opencode.json`; no root test/typecheck script. Path aliases (`jsconfig.json`): `@/*` → `src/*`, `open-sse` → `./open-sse`.

## Tests (`tests/`)

```bash
npm install            # root first — tests import src/ deps (open, undici)
cd tests && npm install  # vitest lives here; cwd MUST be tests/
npx vitest run                          # full (~60s)
npx vitest run unit/capabilities.test.js  # single file
```

- Suite is **not green on clean checkout** (~2000 passed / ~125 failed at 0.5.81). Judge regressions by diffing the fail-set against baseline, never by raw count; ignore committed `test` script (hardcodes Unix `NODE_PATH`).
- Known upstream-stale fails left red: `unit/kiro-external-idp.test.js` endpoint ordering (upstream reordered to `q.*` first, never updated the test). `it.fails` = known bug — flips red when fixed, then flip it to `it` and verify (0.5.81 flipped 2 image-preservation cases).
- Translator tests MUST `import "./registerAll.js"` (ESM `require` no-op → false pass).
- Snapshot churn: delete local `tests/translator/__snapshots__/golden-url-header.test.js.snap` before commit. JSON reporter paths are OS-specific — normalize `\` → `/` to `tests/...`.
- `driver.js` `wrapAsync` makes DB always-async. Old tests calling `db.get/run/all` without `await` (written for upstream sync better-sqlite3) fail — pre-existing debt, don't "fix" in `driver.js`.

## Upstream porting (fork has no common ancestor with upstream)

- Never `merge`/`cherry-pick` — port via `git checkout vX.Y.Z -- <paths>` selective checkout, one version per commit. `package.json` is version-bump-only: bump by hand, never bulk-checkout (keeps `postgres` dep).
- Overlap files need `git merge-file` on **LF-normalized temp copies** (worktree is CRLF via `core.autocrlf`, blobs are LF — merging in place corrupts endings); write back as CRLF. Per-version overlap list: compute via `git diff --name-only vOLD..vNEW` ∩ fork files.
- Port gate per version: `npm run build` green + full vitest fail-set diffed vs baseline. Smoke: `/api/health`, login, `POST→GET→DELETE /api/combos`, cron 401-with-secret / `{"ok":true}`-without (dev default).

## Request flow

`/v1/*` rewrite → `src/app/api/v1/*` → `src/sse/handlers/chat.js` (parse, combo/account loop) → `open-sse/handlers/chatCore.js` (detect format, RTK/headroom/caveman pre-hooks, `getExecutor`, `translateRequest/Response`) → `open-sse/executors/*` → SSE out. Aborts after HTTP 200 are reported in-band (per-format error frames), not silent closes; CommandCode mid-stream errors throw so fallback triggers.

## open-sse conventions

- Pivots through **OpenAI as intermediate**; exact `source:target` pair = direct route (prefer for thinking blocks, tool ids, non-base64 images, `is_error`). Translators self-register via `register()` side effect — new file MUST be imported in `translator/index.js`.
- Never hardcode roles/blocks/models — use `config/` + `translator/schema/`. New provider: copy `providers/REGISTRY_TEMPLATE.js` → `providers/registry/{id}.js` + models in `config/providerModels.js`; `registry/index.js` is auto-generated (use `scripts/migrate-registry.mjs`, don't hand-edit). Only non-OpenAI-compatible upstreams need an executor (`BaseExecutor` subclass, register in `executors/index.js`); binary upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) live in their executor, never the translator. CommandCode image blocks carry both `mediaType` and `mimeType`.
- `rtk/` + headroom/caveman mutate in place and are **fail-open** — never throw; RTK skips `is_error` results. Qoder image uploads go to Qoder's own cloud endpoint, not local disk.

## DB — async fork, upstream is sync

- `src/lib/db/driver.js` order: Supabase (if `DATABASE_URL`|`POSTGRES_URL*`|`SUPABASE_*` set, non-`[YOUR-PASSWORD]`) → `bun:sqlite` → `better-sqlite3` (optional; skipped on Node ≥24 — native addon SIGSEGVs) → `node:sqlite` (≥22.5) → `sql.js`. Always `await db.get/run/all` and `await db.transaction(async () => ...)`.
- Never copy upstream DB code verbatim — re-asyncify it, keep `// Fork note:` comments. New code imports `@/lib/db/index.js` (`src/lib/localDb.js` is a shim); logic in `repos/*`, schema in `migrations/`. No migrations 0.5.65→0.5.81, no `schema.sql` change needed.
- SQLite path via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`); `usageDb.js` (`usage.json`/`log.txt`) stays under `~/.9router` regardless of `DATA_DIR`.
- Local dev needs zero DB config (SQLite). Vercel MUST use Supabase Transaction Pooler `:6543?pgbouncer=true` with user `postgres.<ref>` — direct `:5432` fails (`ENETUNREACH`, `too many clients`). Placeholder `DATABASE_URL` falls back to SQLite (ephemeral). `JWT_SECRET` fail-fasts on Vercel; `INITIAL_PASSWORD` defaults to `123456`; dashboard cookie `maxAge` is 24h. Never set `DATA_DIR` on Vercel. Never commit live refs/hosts/passwords/keys — use `<ref>`/`<region>` placeholders.

## Gotchas to preserve

- `custom-server.js` derives client IP from TCP socket, strips `X-Forwarded-For`/`x-9r-real-ip`, stamps `x-9r-peer-token` — preserve when touching IP/rate-limit/proxy code. Self-probes (`POST /api/models/test`, `pingModelByKind`) use absolute app URL on `VERCEL=1`, loopback otherwise; probe failures return `{ ok:false }` / 200, never 500 (`/api/pxpipe/restart` 409 `NOT_INSTALLED` when missing).
- `v1/models` resolvers are fork-lazy (dynamic import for cold start) — wire new upstream resolvers (`routableQoderModels`, `resolveClineModels`, …) through lazy imports, never static ones.
- JS ESM only, no TS. Conventional Commits (`fix(translator): …`); root and `cli/` versioned independently, log in `CHANGELOG.md`.
