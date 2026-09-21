// Global test isolation: never let the unit/translator suite write to the user's
// real database (~/.9router). Some tests (e.g. zed-live-models, zed-native-auth)
// exercise real route handlers that call createProviderConnection — without this
// they append test rows ("zed-live-*@example.com", "guard-*@example.com",
// "Account N") straight into the live DB.
//
// GUARD — DO NOT DELETE this file or remove it from vitest.config.js setupFiles.
// Covered by tests/unit/test-data-dir-isolation.test.js.
//
// DATA_DIR must be set before src/lib/dataDir.js is imported (it reads the env
// at module-eval time), which is exactly what a vitest setupFile guarantees.
//
// Escape hatches:
//   - RUN_REAL=1        → keep the real DATA_DIR so *.real.test.js can read it.
//   - DATA_DIR=<path>   → respect an explicit override (CI / manual isolation).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUN_REAL = process.env.RUN_REAL === "1";
const explicit = process.env.DATA_DIR;

if (!RUN_REAL && !explicit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-"));
  process.env.DATA_DIR = dir;
  process.on("exit", () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
