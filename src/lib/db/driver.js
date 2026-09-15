import { ensureDirs, DATA_FILE } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

function getSupabaseConnectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.SUPABASE_DB_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    null
  );
}

function isPlaceholderConnectionString(cs) {
  return !cs || cs.includes("[YOUR-PASSWORD]") || cs.includes("%5BYOUR-PASSWORD%5D");
}

// Normalize adapter to always-async interface so callers can `await db.get()` uniformly.
// SQLite adapters are sync; Supabase is already async. Wrapping avoids dual code paths.
function wrapAsync(adapter) {
  if (!adapter || adapter._wrapped) return adapter;
  const orig = adapter;
  const wrap = (fn) => (...args) => Promise.resolve(fn(...args));
  return {
    ...orig,
    _wrapped: true,
    run: wrap(orig.run.bind(orig)),
    get: wrap(orig.get.bind(orig)),
    all: wrap(orig.all.bind(orig)),
    exec: wrap(orig.exec.bind(orig)),
    // Transaction needs special handling: must await async callbacks.
    // For SQLite we emulate BEGIN/COMMIT around the async callback;
    // for Supabase the underlying adapter already handles sql.begin.
    transaction: async (cb) => {
      if (orig.driver === "supabase-postgres") {
        return await orig.transaction(cb);
      }
      // For SQLite, if callback is sync (no Promise), delegate to native transaction for speed.
      // We detect async by checking if cb is AsyncFunction or returns a Promise.
      let result;
      let isAsync = cb.constructor.name === "AsyncFunction";
      if (!isAsync) {
        try {
          // Probe: call via native transaction; if cb returns a Promise we fall through to async path.
          result = orig.transaction(() => {
            const r = cb();
            if (r && typeof r.then === "function") throw new Error("__ASYNC_TX__");
            return r;
          });
          return result;
        } catch (e) {
          if (e.message !== "__ASYNC_TX__") throw e;
          isAsync = true;
        }
      }
      if (isAsync) {
        // Manual async transaction using exec BEGIN/COMMIT (works for all sqlite adapters).
        // Serialize: a second BEGIN while one is open would hit SQLITE_BUSY
        // ("cannot start a transaction within a transaction") — queue behind the
        // in-flight transaction instead of hiding the error and committing early.
        // The chain lives on the underlying adapter so all wrapped handles share it.
        if (!orig._asyncTxChain) orig._asyncTxChain = Promise.resolve();
        const prev = orig._asyncTxChain;
        let release;
        const cur = new Promise((resolve) => { release = resolve; });
        orig._asyncTxChain = prev.then(() => cur);
        await prev;
        try {
          // BEGIN failure here is real (locked/corrupt) — surface it, never
          // pretend a transaction is open.
          await orig.exec("BEGIN IMMEDIATE");
          try {
            result = await cb();
          } catch (err) {
            try {
              await orig.exec("ROLLBACK");
            } catch {}
            throw err;
          }
          await orig.exec("COMMIT");
          return result;
        } finally {
          release();
        }
      }
      return result;
    },
  };
}

async function trySupabase() {
  const cs = getSupabaseConnectionString();
  if (!cs) return null;
  if (isPlaceholderConnectionString(cs)) {
    console.warn(
      "[DB] DATABASE_URL contains placeholder [YOUR-PASSWORD] — skipping Supabase, falling back to SQLite. Set real password in .env / Vercel env.",
    );
    return null;
  }
  try {
    const { createSupabaseAdapter } = await import("./adapters/supabaseAdapter.js");
    const adapter = await createSupabaseAdapter(cs);
    return wrapAsync(adapter);
  } catch (e) {
    console.warn(`[DB] supabase-postgres unavailable: ${e.message} — falling back to SQLite`);
    return null;
  }
}

async function tryBunSqlite() {
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    const a = await createBunSqliteAdapter(DATA_FILE);
    return wrapAsync(a);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite() {
  if (process.versions.bun) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    const a = createBetterSqliteAdapter(DATA_FILE);
    return wrapAsync(a);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite() {
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    const a = await createNodeSqliteAdapter(DATA_FILE);
    return wrapAsync(a);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    const a = await createSqlJsAdapter(DATA_FILE);
    return wrapAsync(a);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

async function initAdapter() {
  // Supabase first — no filesystem needed, Vercel/serverless path
  let adapter = await trySupabase();
  if (adapter) {
    if (!state.logged) {
      // Supabase adapter already logged host; just mark
      state.logged = true;
    }
    const { runMigrationOnce } = await import("./migrate.js");
    await runMigrationOnce(adapter);
    return adapter;
  }

  // SQLite fallback — needs filesystem
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

// Fail-fast guard: adapter init (TLS + SELECT 1 + migrations) normally takes
// ~1-2.5s colocated. If it stalls (half-dead pooled socket after a
// freeze/thaw), don't hang the request for a minute — reset the pool, retry
// once, then throw so the client retries on a healthy instance.
const INIT_TIMEOUT_MS = 20000;

function settleInit() {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: `timeout ${INIT_TIMEOUT_MS}ms` });
      }
    }, INIT_TIMEOUT_MS);
    timer.unref?.();
    initAdapter().then(
      (adapter) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ ok: true, adapter });
        }
      },
      (error) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, error: error?.message || String(error) });
        }
      },
    );
  });
}

async function initWithRecovery() {
  const t0 = Date.now();
  try {
    const first = await settleInit();
    if (first.ok) {
      state.instance = first.adapter;
      console.log(`[DB] adapter ready in ${Date.now() - t0}ms (${first.adapter.driver})`);
      return first.adapter;
    }
    console.warn(`[DB] adapter init stalled/failed (${first.error}) — resetting pool, retrying once`);
    // Drop half-dead sockets: the adapter module recreates the pool when
    // globalThis._supabaseSql is null (see createSupabaseAdapter).
    try {
      if (state.instance?.resetPool) await state.instance.resetPool();
      else if (typeof globalThis !== "undefined" && globalThis._supabaseSql?.end) {
        try { await globalThis._supabaseSql.end({ timeout: 2 }); } catch {}
        globalThis._supabaseSql = null;
      }
    } catch {}
    state.initPromise = null;
    state.instance = null;
    const second = await settleInit();
    if (!second.ok) throw new Error(`[DB] adapter init failed twice (${second.error})`);
    state.instance = second.adapter;
    console.log(`[DB] adapter ready in ${Date.now() - t0}ms (${second.adapter.driver}) [retry]`);
    return second.adapter;
  } catch (e) {
    // Don't brick the instance on a rejected init — let the next request try fresh.
    state.initPromise = null;
    state.instance = null;
    throw e;
  }
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initWithRecovery();
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}

export function isSupabaseMode() {
  return !!getSupabaseConnectionString() && !isPlaceholderConnectionString(getSupabaseConnectionString());
}
