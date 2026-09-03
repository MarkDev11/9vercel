// JSON cache for mitmAlias — read by standalone MITM server (no SQLite native binding).
// Source of truth = SQLite kv['mitmAlias']. JSON is a read-replica synced on app start
// and after every UI write.
import fs from "fs";
import path from "path";
import os from "os";

const APP_NAME = "9router";

function defaultDir() {
  if (process.env.VERCEL) {
    try { fs.mkdirSync("/tmp/.9router", { recursive: true }); return "/tmp/.9router"; } catch {}
    return "/tmp";
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function getDataDir() {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows -> fallback to default`);
    return defaultDir();
  }
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (process.env.VERCEL) {
      console.warn(`[DATA_DIR] '${configured}' not writable on Vercel (${e?.code}) -> fallback to /tmp`);
      try { fs.mkdirSync("/tmp/.9router", { recursive: true }); return "/tmp/.9router"; } catch {}
      return "/tmp";
    }
    if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS" || e?.code === "ENOSPC" || e?.code === "ENOTDIR" || e?.code === "ENOENT") {
      console.warn(`[DATA_DIR] '${configured}' not writable (${e?.code}) -> fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

let _dir;
try { _dir = getDataDir(); } catch (e) {
  console.warn(`[DATA_DIR] getDataDir threw (${e?.code || e?.message}) -> fallback /tmp`);
  _dir = process.env.VERCEL ? "/tmp" : defaultDir();
}
const DATA_DIR = _dir;

const CACHE_FILE = path.join(DATA_DIR, "mitm", "aliases.json");

function writeAtomic(data) {
  try {
    const dir = path.dirname(CACHE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    if (process.env.VERCEL) {
      console.warn(`[mitmAliasCache] writeAtomic skipped on Vercel (${e?.code || e?.message})`);
      return;
    }
    throw e;
  }
}

// Sync entire mitmAlias map from DB → JSON file
export async function syncToJson() {
  try {
    const { getMitmAlias } = await import("@/lib/db/repos/aliasRepo.js");
    const all = await getMitmAlias();
    writeAtomic(all || {});
  } catch (e) {
    console.log("[mitmAliasCache] sync failed:", e.message);
  }
}

// Update cache for a single tool after UI saves to DB
export function writeAliasForTool(tool, mappings) {
  try {
    let current = {};
    if (fs.existsSync(CACHE_FILE)) {
      try { current = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* corrupted → reset */ }
    }
    current[tool] = mappings || {};
    writeAtomic(current);
  } catch (e) {
    console.log("[mitmAliasCache] write failed:", e.message);
  }
}
