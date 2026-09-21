// Guard: the test harness must never write into the user's real DB.
//
// Root cause this locks down: route-level tests (zed-live-models,
// zed-native-auth) call createProviderConnection, which persists to
// $DATA_DIR/db/data.sqlite. With no DATA_DIR set, that resolved to ~/.9router —
// polluting the live DB with "zed-live-*@example.com", "guard-*@example.com"
// and "Account N" rows on every `npx vitest run`.
//
// tests/setup/isolateDataDir.js redirects DATA_DIR to a temp dir unless the
// caller opts out via RUN_REAL=1 or an explicit DATA_DIR.
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";

// When the caller opts into the real DB (RUN_REAL=1) or supplies DATA_DIR,
// isolation is intentionally disabled — this guard only applies to the default.
const ISOLATED = !process.env.RUN_REAL && !process.env.EXPECT_REAL_DATA_DIR;

describe.skipIf(!ISOLATED)("test DATA_DIR isolation", () => {
  it("points DATA_DIR at a temp dir, not ~/.9router", () => {
    const dir = process.env.DATA_DIR;
    expect(dir).toBeTruthy();
    const home = path.join(os.homedir(), ".9router");
    expect(path.resolve(dir)).not.toBe(path.resolve(home));
    expect(dir.startsWith(os.tmpdir())).toBe(true);
  });
});
