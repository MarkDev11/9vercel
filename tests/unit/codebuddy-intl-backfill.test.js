// Existing CodeBuddy Intl OAuth connections created before mapTokens surfaced
// identity show up as "Account N" with no email. The self-healing backfill must
// fill email + displayName from the access-token JWT so the dashboard shows the
// real identity without forcing a re-login.
//
// backfillCodeBuddyIntlIdentity has a module-level run-once guard, so each test
// re-imports a fresh module instance via vi.resetModules() + dynamic import.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
}));

// The providers index imports open-sse/index.js for proxy-aware fetch; stub it.
vi.mock("open-sse/index.js", () => ({}));

function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

const JWT = makeJwt({
  iss: "https://www.codebuddy.ai/auth/realms/copilot",
  email: "aghiyaramadh@gmail.com",
  name: "aghiya ramadh",
});

async function loadBackfill() {
  vi.resetModules();
  const mod = await import("../../src/lib/oauth/providers/index.js");
  return mod.backfillCodeBuddyIntlIdentity;
}

describe("backfillCodeBuddyIntlIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProviderConnection.mockResolvedValue({});
  });

  it("fills email + displayName for a legacy 'Account N' connection", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-legacy",
        provider: "codebuddy-intl",
        authType: "oauth",
        name: "Account 1",
        email: null,
        displayName: null,
        accessToken: JWT,
      },
    ]);

    const backfill = await loadBackfill();
    await backfill();

    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const [id, patch] = mocks.updateProviderConnection.mock.calls[0];
    expect(id).toBe("conn-legacy");
    expect(patch.email).toBe("aghiyaramadh@gmail.com");
    expect(patch.displayName).toBe("aghiya ramadh");
    // Generic placeholder name is replaced by the identity.
    expect(patch.name).toBe("aghiyaramadh@gmail.com");
  });

  it("keeps a user-customized name (does not overwrite non-generic names)", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-custom",
        provider: "codebuddy-intl",
        authType: "oauth",
        name: "My Work Account",
        email: null,
        displayName: null,
        accessToken: JWT,
      },
    ]);

    const backfill = await loadBackfill();
    await backfill();

    expect(mocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const [, patch] = mocks.updateProviderConnection.mock.calls[0];
    expect(patch.email).toBe("aghiyaramadh@gmail.com");
    expect(patch.name).toBeUndefined();
  });

  it("leaves connections that already have identity untouched", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-ok",
        provider: "codebuddy-intl",
        authType: "oauth",
        name: "aghiya ramadh",
        email: "aghiyaramadh@gmail.com",
        displayName: "aghiya ramadh",
        accessToken: JWT,
      },
    ]);

    const backfill = await loadBackfill();
    await backfill();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
  it("ignores other providers", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codex", authType: "oauth", email: null, accessToken: JWT },
    ]);

    const backfill = await loadBackfill();
    await backfill();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
