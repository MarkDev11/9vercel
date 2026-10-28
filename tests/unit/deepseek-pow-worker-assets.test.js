// Locks the DeepSeek web PoW worker wiring. The worker is spawned from a raw
// path (worker_threads), so the file tracer only ships the worker script and
// never the sibling hash module it imports — the deployed serverless bundle
// then fails with "Cannot find module '/var/task/open-sse/lib/deepseek-pow-hash.*'".
// These tests pin the on-disk contract: the worker file exists next to the
// module it imports, and that import resolves as ESM.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const libDir = path.join(repoRoot, "open-sse", "lib");
const workerPath = path.join(libDir, "deepseek-pow-worker.mjs");

describe("deepseek-pow worker assets", () => {
  it("ships the worker script next to the hash module it imports", () => {
    expect(existsSync(workerPath)).toBe(true);
    const workerSource = readFileSync(workerPath, "utf8");
    const match = workerSource.match(/from\s+"(\.\/[^"]+)"/);
    expect(match).not.toBeNull();
    const imported = path.join(libDir, match[1]);
    expect(existsSync(imported)).toBe(true);
  });

  it("uses an .mjs extension so Node parses the runtime-loaded files as ESM", () => {
    // The repo root package.json has no "type": "module", so a bare ".js"
    // would be parsed as CommonJS by the serverless runtime.
    const workerSource = readFileSync(workerPath, "utf8");
    const match = workerSource.match(/from\s+"(\.\/[^"]+)"/);
    expect(match[1].endsWith(".mjs")).toBe(true);
  });

  it("resolves the worker path from the repo layout the runtime ships", () => {
    // deepseek-pow.js anchors the worker on process.cwd(); the deployed bundle
    // must keep the open-sse/lib/ layout relative to the app root.
    const solverSource = readFileSync(path.join(libDir, "deepseek-pow.js"), "utf8");
    expect(solverSource).toContain('path.join("open-sse", "lib", "deepseek-pow-worker.mjs")');
  });

  it("solves a challenge through the spawned worker", async () => {
    const { deepSeekHashV1 } = await import("../../open-sse/lib/deepseek-pow-hash.mjs");
    const { solveDeepSeekPowAsync } = await import("../../open-sse/lib/deepseek-pow.js");
    const salt = "salt";
    const expireAt = 12345;
    const prefix = `${salt}_${expireAt}_`;
    const target = deepSeekHashV1(`${prefix}0`);
    const nonce = await solveDeepSeekPowAsync("DeepSeekHashV1", target, salt, 200000, expireAt);
    expect(nonce).toBe(0);
    expect(deepSeekHashV1(`${prefix}${nonce}`)).toBe(target);
  });
});
