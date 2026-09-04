import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "disabledModels";

export async function getDisabledModels() {
  const db = await getAdapter();
  const rows = await db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, []);
  return out;
}

export async function getDisabledByProvider(providerAlias) {
  const db = await getAdapter();
  const row = await db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
  return row ? (parseJson(row.value, []) || []) : [];
}

// Concurrent-safe merge: read the current list, then merge inside a single
// UPDATE statement whose WHERE clause re-checks the value we read. If a
// parallel writer changed it first, the UPDATE affects 0 rows and we retry —
// so N parallel disableModels() calls union instead of last-write-wins.
// (Wrapping read+write in a transaction is NOT enough: the awaits yield and
// parallel transactions interleave on both SQLite-emulated and Postgres tx.)
async function mergeJsonList(db, providerAlias, mergeFn, maxRetries = 80) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const row = await db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    const next = mergeFn(current);
    if (!row) {
      try {
        // Decide the winner by `changes`, not by comparing stored ids: every
        // racing caller carries the same single-id union (["d-i"]) and would
        // all claim the row; changes > 0 identifies the true inserter.
        const ins = await db.run(
          `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO NOTHING`,
          [SCOPE, providerAlias, stringifyJson(next)]
        );
        if ((ins?.changes ?? 0) > 0) return;
        continue; // someone else inserted first — fall through to update path
      } catch {
        continue; // lost the insert race — re-read and update instead
      }
    }
    const res = await db.run(
      `UPDATE kv SET value = ? WHERE scope = ? AND key = ? AND value = ?`,
      [stringifyJson(next), SCOPE, providerAlias, row.value]
    );
    if ((res?.changes ?? 0) > 0) return;
    // 0 rows: parallel writer won the race — re-read and retry.
  }
  // Exhausted retries (extreme contention): fall back to a plain union write
  // rather than dropping the caller's ids silently.
  const row = await db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
  const current = row ? (parseJson(row.value, []) || []) : [];
  await db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, providerAlias, stringifyJson(mergeFn(current))]
  );
}

export async function disableModels(providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  const db = await getAdapter();
  await mergeJsonList(db, providerAlias, (current) => [...new Set([...current, ...ids])]);
}

export async function enableModels(providerAlias, ids) {
  if (!providerAlias) return;
  const db = await getAdapter();
  if (!Array.isArray(ids) || ids.length === 0) {
    await db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    return;
  }
  const removeSet = new Set(ids);
  await mergeJsonList(db, providerAlias, (current) => current.filter((id) => !removeSet.has(id)));
  // mergeJsonList never deletes the row — clean up the empty-list tombstone.
  const row = await db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
  if (row && (parseJson(row.value, []) || []).length === 0) {
    await db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
  }
}
