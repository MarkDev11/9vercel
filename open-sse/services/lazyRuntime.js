// Lazy loader for heavy optional runtime deps (playwright-core, wreq-js).
//
// They are devDependencies only, so end-user installs stay small. On first
// use the package is downloaded into <DATA_DIR>/runtime (same pattern as
// cli/hooks/sqliteRuntime.js) and imported from there. Resolution order:
// app node_modules (dev / traced standalone) → runtime dir → npm install.
//
// Never throws at import time of THIS module — failures surface from
// loadRuntimeDep() with a manual-install hint.
//
// Fork note (Vercel): do NOT use createRequire() here. Webpack replaces
// `node:module`'s createRequire with an empty CJS stub, so
// `createRequire(...).resolve` is `undefined` and every call dies with
// "Cannot read properties of undefined (reading 'resolve')". `import.meta.resolve`
// is a native ESM primitive (Node >= 20.6) and survives bundling, so it is
// the primary lookup; `process.getBuiltinModule("module")` is the fallback for
// runtimes that lack it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json devDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

/**
 * Resolve a package to an absolute file URL without createRequire.
 * Returns null when the package is not installed.
 *
 * Order:
 *  1. process.getBuiltinModule("module").createRequire — `process` is a real
 *     global at runtime and webpack never stubs it, so this survives bundling.
 *  2. import.meta.resolve — native ESM primitive, but webpack may replace
 *     `import.meta` with a partial shim.
 */
function resolvePackageUrl(pkg, base) {
  // 1) Builtin "module" via getBuiltinModule (not bundled by webpack).
  try {
    const mod = process.getBuiltinModule?.("module");
    const createRequire = mod?.createRequire;
    if (typeof createRequire === "function") {
      const bases = base
        ? [base]
        : [path.join(getRuntimeDir(), "package.json"), path.join(process.cwd(), "package.json")];
      for (const b of bases) {
        try {
          return pathToFileURL(createRequire(b).resolve(pkg)).href;
        } catch {
          /* try the next base */
        }
      }
    }
  } catch {
    /* fall through */
  }
  // 2) Native ESM resolution — relative to this module (app install).
  try {
    const url = import.meta.resolve(pkg);
    if (url) return url;
  } catch {
    /* not installed here — give up */
  }
  return null;
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg}@${version}`];
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error.message || error) }));
    child.on("close", (status) => resolve({ ok: status === 0, stderr }));
  });
}

const inflight = new Map();

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  const appUrl = resolvePackageUrl(pkg);
  if (appUrl) {
    try {
      return await import(/* webpackIgnore: true */ appUrl);
    } catch (error) {
      if (!isModuleMissing(error)) throw error;
    }
  }
  // 2) Already present in the runtime dir from a previous install.
  const runtimeUrl = resolvePackageUrl(pkg, path.join(getRuntimeDir(), "package.json"));
  if (runtimeUrl) {
    try {
      return await import(/* webpackIgnore: true */ runtimeUrl);
    } catch (error) {
      if (!isModuleMissing(error)) throw error;
    }
  }
  // 3) Download on demand, then import from the runtime dir.
  const version = LAZY_DEP_VERSIONS[pkg] || "latest";
  const dir = getRuntimeDir();
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    const reason = (res.stderr.match(/npm ERR! ?(.+)/) || [])[1] || res.stderr.split("\n").filter(Boolean).pop() || "unknown npm error";
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${String(reason).slice(0, 160)}) — ` +
      `install it manually: cd "${dir}" && npm install ${pkg}@${version}`
    );
  }
  const installedUrl = resolvePackageUrl(pkg, path.join(dir, "package.json"));
  if (!installedUrl) {
    throw new Error(`${pkg} was installed into "${dir}" but could not be resolved from there`);
  }
  return import(/* webpackIgnore: true */ installedUrl);
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
