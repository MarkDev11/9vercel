import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function normalizeModelEntry(entry) {
  if (typeof entry === "string") return entry.trim() || null;
  if (entry && typeof entry === "object") {
    if (typeof entry.value === "string" && entry.value.trim()) return entry.value.trim();
    if (typeof entry.model === "string") {
      const prov = typeof entry.provider === "string" && entry.provider.trim() ? entry.provider.trim() : "";
      const mod = entry.model.trim();
      if (!mod) return null;
      return prov ? `${prov}/${mod}` : mod;
    }
    if (typeof entry.id === "string" && entry.id.trim()) return entry.id.trim();
    if (typeof entry.name === "string" && entry.name.trim()) return entry.name.trim();
  }
  return null;
}
function normalizeModels(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeModelEntry).filter(Boolean);
}

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: normalizeModels(parseJson(row.models, [])),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = await db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = await db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = await db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: normalizeModels(data.models || []),
    createdAt: now,
    updatedAt: now,
  };
  await db.run(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  await db.transaction(async () => {
    const row = await db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const base = rowToCombo(row);
    const patch = { ...data };
    if (patch.models !== undefined) patch.models = normalizeModels(patch.models);
    const merged = { ...base, ...patch, updatedAt: new Date().toISOString() };
    await db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = await db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
