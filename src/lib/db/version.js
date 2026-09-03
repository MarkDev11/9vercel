import { createRequire } from "node:module";

let cachedVersion = null;

export function getAppVersion() {
  if (cachedVersion) return cachedVersion;
  // On Vercel the standalone build may not bundle package.json at process.cwd().
  // Use createRequire relative to this file (works in both dev and .next/standalone),
  // fall back to env or 0.0.0 — never throw.
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json");
    cachedVersion = pkg?.version || process.env.npm_package_version || "0.0.0";
  } catch {
    cachedVersion = process.env.npm_package_version || "0.0.0";
  }
  return cachedVersion;
}

export function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
