import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic upsert inside transaction to prevent duplicate races.
// Re-adding an existing model updates caps/name without resetting omitted fields.
// Fork note: kept async (await db.transaction/get/run) — our Supabase adapter is
// always-async; upstream's sync form only works on better-sqlite3.
export async function addCustomModel({ providerAlias, id, type = "llm", name, caps }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  // Concurrent-safe: two parallel inserts for the same key must not throw
  // UNIQUE constraint — the loser re-reads and merges instead. Retry on
  // write-write races (compare-and-swap on value, like disabledModels).
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(row.value) || {};
      const next = { ...prev, ...(name ? { name } : {}), ...(caps ? { caps } : {}) };
      const prevStr = row.value;
      const nextStr = stringifyJson(next);
      if (prevStr === nextStr) return false;
      const res = await db.run(
        `UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ? AND value = ?`,
        [nextStr, k, prevStr]
      );
      if ((res?.changes ?? 0) > 0) return false;
      continue; // parallel writer won — re-read and retry
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...(caps ? { caps } : {}) });
    try {
      // Decide the winner by `changes`, not by re-reading the stored value:
      // every loser sees the winner's identical value string and would also
      // claim the insert. changes > 0 means we own the new row.
      const ins = await db.run(
        `INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?) ON CONFLICT(scope, key) DO NOTHING`,
        [k, value]
      );
      if ((ins?.changes ?? 0) > 0) return true;
      // Someone else inserted first — loop around to merge path.
    } catch {
      // Lost the insert race — re-read and merge instead of throwing.
    }
  }
  return false;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
