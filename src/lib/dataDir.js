import fs from "node:fs";
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

export function getDataDir() {
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
    if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS" || e?.code === "ENOSPC" || e?.code === "ENOTDIR") {
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
export const DATA_DIR = _dir;
