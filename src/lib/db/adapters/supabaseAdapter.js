// Supabase Postgres adapter — drop-in replacement for better-sqlite3 / sql.js / node:sqlite / bun:sqlite
// Uses `postgres` (postgres.js) with raw SQL over Supabase's Postgres (DATABASE_URL / POSTGRES_URL).
// Fallback: if postgres package not available or no DATABASE_URL, driver.js falls back to SQLite.
//
// Why `postgres` and not @supabase/supabase-js?
//   - @supabase/supabase-js is PostgREST (REST), not raw SQL — would require rewriting every query.
//   - `postgres` lets us keep 95% of existing SQLite SQL (just translate ? → $n and INSERT OR REPLACE).
//
// Interface matches other adapters:
//   { driver, run(sql, params), get(sql, params), all(sql, params), exec(sql), transaction(fn), close(), raw }

import { randomUUID } from "node:crypto";

let globalSql = null;

// Transaction client is tracked per-transaction via AsyncLocalStorage so
// concurrent sql.begin() callbacks on serverless never share/overwrite it.
// Falls back to a module-global only on runtimes without node:async_hooks
// (always present on Node 16+, but keep the fallback for Bun/edge safety).
import { AsyncLocalStorage } from "node:async_hooks";
const txStore = typeof AsyncLocalStorage !== "undefined" ? new AsyncLocalStorage() : null;
let txClientFallback = null;

function getClient() {
  if (txStore) return txStore.getStore() || globalSql;
  return txClientFallback || globalSql;
}

// Postgres lowercases unquoted identifiers; app expects camelCase.
// Normalize row keys so `row.authType` still works on Supabase.
// Generic lower→camel fold covers every current + future column (testStatus,
// authType, …) without maintaining an allowlist that silently drops new keys.
function lowerToCamel(key) {
  return key.replace(/_([a-z0-9])/gi, (_, c) => String(c).toUpperCase());
}
function normalizeRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  let needs = false;
  for (const k of Object.keys(row)) {
    // Postgres-folded keys are all-lowercase with no underscores (e.g.
    // "teststatus"); skip keys that already look camelCase.
    if (k === k.toLowerCase() && !k.includes("_") && k !== lowerToCamel(k) && !(lowerToCamel(k) in row)) { needs = true; break; }
  }
  if (!needs) return row;
  const out = { ...row };
  for (const k of Object.keys(row)) {
    if (k === k.toLowerCase() && !k.includes("_")) {
      const camel = lowerToCamel(k);
      if (camel !== k && !(camel in out)) out[camel] = out[k];
    }
  }
  return out;
}
function normalizeRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(normalizeRow);
}

// Translate SQLite-isms to Postgres.
//  - ? placeholders → $1,$2,...
//  - INSERT OR REPLACE → INSERT ... ON CONFLICT DO UPDATE
//  - INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING (rare, but handle)
//  - PRAGMA / journal_mode etc → noop
function translateSql(sql) {
  if (!sql || typeof sql !== "string") return sql;

  const trimmed = sql.trim();

  // No-op pragmas and SQLite-only statements on Postgres
  if (/^PRAGMA/i.test(trimmed) || /^PRAGMA\s/i.test(sql)) return null; // signal to skip
  if (/wal_checkpoint/i.test(sql)) return null;
  if (/VACUUM/i.test(trimmed)) return null;
  if (/ATTACH DATABASE/i.test(trimmed)) return null;
  if (/DETACH DATABASE/i.test(trimmed)) return null;
  // PRAGMA table_info(...) used in syncSchemaFromTables — return null so caller can handle
  if (/PRAGMA\s+table_info/i.test(sql)) return null;

  let out = sql;

  // --- DDL translation SQLite -> Postgres ---
  // usageHistory uses INTEGER PRIMARY KEY AUTOINCREMENT which Postgres rejects.
  // Supabase schema uses SERIAL; translate here so auto-migrate (001-initial) works
  // even if supabase/schema.sql was not run manually.
  if (/CREATE\s+TABLE/i.test(out)) {
    out = out.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");
    // leftover AUTOINCREMENT (should not remain after above, but strip defensively)
    out = out.replace(/\bAUTOINCREMENT\b/gi, "");
    // SQLite REAL affinity -> Postgres DOUBLE PRECISION (REAL also works but be explicit)
    // Keep TEXT/INTEGER as-is — Postgres accepts them.
  }

  // INSERT OR REPLACE → Postgres upsert. Infer ON CONFLICT from column list when missing.
  if (/^INSERT\s+OR\s+REPLACE\b/i.test(out)) {
    if (/ON\s+CONFLICT/i.test(out)) {
      out = out.replace(/^INSERT\s+OR\s+REPLACE\b/i, "INSERT");
    } else {
      out = out.replace(/^INSERT\s+OR\s+REPLACE\b/i, "INSERT");
      out = out.replace(/;\s*$/, "");
      if (!/ON\s+CONFLICT/i.test(out)) {
        const colMatch = out.match(/INSERT\s+INTO\s+["']?([\w]+)["']?\s*\(([^)]+)\)/i);
        if (colMatch) {
          const table = colMatch[1].replace(/"/g, "").toLowerCase();
          const cols = colMatch[2].split(",").map((c) => c.trim().replace(/"/g, ""));
          const lowCols = cols.map((c) => c.toLowerCase());
          let conflictCols = null;
          let updateCols = [];
          if (table === "kv" || (lowCols.includes("scope") && lowCols.includes("key"))) {
            conflictCols = "(scope, key)";
            updateCols = cols.filter((c) => !["scope", "key"].includes(c.toLowerCase()));
          } else if (lowCols.includes("id")) {
            conflictCols = "(id)";
            updateCols = cols.filter((c) => c.toLowerCase() !== "id");
          } else if (lowCols.includes("datekey")) {
            conflictCols = "(dateKey)";
            updateCols = cols.filter((c) => c.toLowerCase() !== "datekey");
          } else if (lowCols.includes("key")) {
            conflictCols = "(key)";
            updateCols = cols.filter((c) => c.toLowerCase() !== "key");
          }
          if (conflictCols) {
            if (updateCols.length) {
              const sets = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
              out += ` ON CONFLICT${conflictCols} DO UPDATE SET ${sets}`;
            } else {
              out += ` ON CONFLICT${conflictCols} DO NOTHING`;
            }
          } else {
            out += " ON CONFLICT DO NOTHING";
          }
        } else {
          out += " ON CONFLICT DO NOTHING";
        }
      }
    }
  }

  if (/^INSERT\s+OR\s+IGNORE\b/i.test(out)) {
    out = out.replace(/^INSERT\s+OR\s+IGNORE\b/i, "INSERT");
    if (!/ON\s+CONFLICT/i.test(out)) out += " ON CONFLICT DO NOTHING";
  }

  // ? -> $n (safe: no ? appears inside string literals in this codebase)
  let idx = 0;
  out = out.replace(/\?/g, () => `$${++idx}`);

  return out;
}

function toPg(sqlStr) {
  const t = translateSql(sqlStr);
  return t; // may be null meaning skip
}

export async function createSupabaseAdapter(connectionString) {
  let postgresPkg;
  try {
    postgresPkg = await import("postgres");
  } catch (e) {
    throw new Error(
      `[DB] postgres package not installed. Run: npm install postgres — ${e.message}`,
    );
  }
  const postgres = postgresPkg.default || postgresPkg;

  // Reuse global connection across hot-reload / serverless invocations
  if (!global._supabaseSql) global._supabaseSql = null;
  if (global._supabaseSql) {
    globalSql = global._supabaseSql;
  } else {
    // Serverless-friendly settings: low pool, no prepared statements (pgbouncer)
    globalSql = postgres(connectionString, {
      prepare: false,
      max: 5,
      idle_timeout: 10,
      connect_timeout: 10,
      max_lifetime: 60 * 30,
      // Suppress notice logs
      onnotice: () => {},
    });
    global._supabaseSql = globalSql;
  }
  const sql = globalSql;

  // Verify connectivity — fail fast if connection string is wrong
  try {
    await sql`SELECT 1 as ok`;
  } catch (e) {
    console.warn(`[DB] Supabase connection test failed: ${e.message}`);
    throw e;
  }

  console.log(`[DB] Driver: supabase-postgres | host: ${new URL(connectionString).hostname}`);

  async function run(sqlStr, params = []) {
    const pgSql = toPg(sqlStr);
    if (pgSql === null) return { changes: 0, lastInsertRowid: 0 };
    try {
      const client = getClient();
      const isInsert = /^\s*INSERT\b/i.test(pgSql);
      const needsReturning = isInsert && /usageHistory/i.test(pgSql) && !/RETURNING/i.test(pgSql);
      const finalSql = needsReturning ? `${pgSql} RETURNING id` : pgSql;
      const rows = await client.unsafe(finalSql, params);
      const lastId = rows?.[0]?.id ?? 0;
      // postgres.js Result is a row array carrying `.count` (affected rows).
      // UPDATE/DELETE without RETURNING yield [] even when rows were
      // affected — prefer .count there. INSERT … ON CONFLICT DO NOTHING that
      // touches 0 rows must report 0, never inflate to 1.
      const count = Array.isArray(rows) && typeof rows.count === "number" ? rows.count : null;
      let changes;
      if (rows && rows.length) changes = rows.length;
      else if (count !== null) changes = count;
      else changes = isInsert ? 1 : 0;
      return { changes, lastInsertRowid: Number(lastId) || 0 };
    } catch (e) {
      e.message = `[supabase] ${e.message} | SQL: ${sqlStr.slice(0, 200)}`;
      throw e;
    }
  }

  async function get(sqlStr, params = []) {
    const pgSql = toPg(sqlStr);
    if (pgSql === null) return undefined;
    if (/PRAGMA\s+table_info/i.test(sqlStr)) return undefined;
    try {
      const client = getClient();
      const rows = await client.unsafe(pgSql, params);
      const row = rows?.[0] ?? undefined;
      return row ? normalizeRow(row) : undefined;
    } catch (e) {
      if (/PRAGMA/i.test(sqlStr)) return undefined;
      e.message = `[supabase] ${e.message} | SQL: ${sqlStr.slice(0, 200)}`;
      throw e;
    }
  }

  async function all(sqlStr, params = []) {
    const pgSql = toPg(sqlStr);
    if (pgSql === null) return [];
    try {
      const client = getClient();
      const rows = await client.unsafe(pgSql, params);
      return normalizeRows(rows ?? []);
    } catch (e) {
      if (/PRAGMA/i.test(sqlStr)) return [];
      e.message = `[supabase] ${e.message} | SQL: ${sqlStr.slice(0, 200)}`;
      throw e;
    }
  }

  async function exec(sqlStr) {
    if (!sqlStr || !sqlStr.trim()) return;
    const stmts = sqlStr
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of stmts) {
      const pgSql = toPg(stmt);
      if (pgSql === null) continue;
      if (!pgSql.trim()) continue;
      try {
        const client = getClient();
        await client.unsafe(pgSql);
      } catch (e) {
        if (/PRAGMA/i.test(stmt)) continue;
        if (/already exists/i.test(e.message) && /CREATE TABLE/i.test(stmt)) continue;
        if (/already exists/i.test(e.message) && /CREATE INDEX/i.test(stmt)) continue;
        e.message = `[supabase] ${e.message} | SQL: ${stmt.slice(0, 200)}`;
        throw e;
      }
    }
  }

  async function transaction(fn) {
    if (typeof sql.begin === "function") {
      return await sql.begin(async (tx) => {
        // Scope the tx client to this transaction's async context so parallel
        // transactions on the same adapter never see each other's client.
        if (txStore) return await txStore.run(tx, () => fn());
        txClientFallback = tx;
        try {
          return await fn();
        } finally {
          txClientFallback = null;
        }
      });
    }
    return await fn();
  }

  function close() {
    try {
      if (globalSql && typeof globalSql.end === "function") {
        globalSql.end({ timeout: 2 }).catch(() => {});
      }
    } catch {}
  }

  return {
    driver: "supabase-postgres",
    run,
    get,
    all,
    exec,
    transaction,
    close,
    raw: sql,
  };
}
