import { getAdapter } from "../driver.js";

export async function getMeta(key, fallback = null) {
  const db = await getAdapter();
  const row = await db.get(`SELECT value FROM _meta WHERE key = ?`, [key]);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await getAdapter();
  await db.run(`INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(value)]);
}

// Sync versions for use during migration (adapter passed directly)
export async function getMetaSync(adapter, key, fallback = null) {
  const row = await adapter.get(`SELECT value FROM _meta WHERE key = ?`, [key]);
  return row ? row.value : fallback;
}

export async function setMetaSync(adapter, key, value) {
  await adapter.run(`INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(value)]);
}
