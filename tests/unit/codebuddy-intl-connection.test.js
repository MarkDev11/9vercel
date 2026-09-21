// CodeBuddy Intl (.ai) OAuth connections:
//  1. The connection test must actually probe the token (was "Provider test not supported"
//     because codebuddy-intl was missing from OAUTH_TEST_CONFIG).
//  2. mapTokens must surface email/displayName from the access token JWT so a fresh OAuth
//     login is named by identity instead of falling back to "Account N".
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

import codebuddyIntl from "../../src/lib/oauth/providers/codebuddy-intl.js";
import { testSingleConnection } from "../../src/app/api/providers/[id]/test/testUtils.js";

// Minimal unsigned JWT (header.payload.sig) — mapTokens only decodes the payload.
function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

const originalFetch = global.fetch;

describe("codebuddy-intl mapTokens identity", () => {
  it("extracts email and display name from the access token JWT", () => {
    const token = makeJwt({
      iss: "https://www.codebuddy.ai/auth/realms/copilot",
      email: "aghiyaramadh@gmail.com",
      name: "aghiya ramadh",
      preferred_username: "aghiyaramadh@gmail.com",
    });

    const out = codebuddyIntl.mapTokens({
      access_token: token,
      refresh_token: "rt",
      expires_in: 3600,
    });

    expect(out.accessToken).toBe(token);
    expect(out.refreshToken).toBe("rt");
    expect(out.email).toBe("aghiyaramadh@gmail.com");
    expect(out.displayName).toBe("aghiya ramadh");
  });

  it("falls back to given/family name when name is absent", () => {
    const token = makeJwt({ email: "a@b.com", given_name: "Aghiya", family_name: "Ramadh" });
    const out = codebuddyIntl.mapTokens({ access_token: token, expires_in: 3600 });
    expect(out.email).toBe("a@b.com");
    expect(out.displayName).toBe("Aghiya Ramadh");
  });

  it("does not throw and leaves identity null for an opaque (non-JWT) token", () => {
    const out = codebuddyIntl.mapTokens({ access_token: "opaque-token", expires_in: 3600 });
    expect(out.accessToken).toBe("opaque-token");
    expect(out.email).toBeNull();
    expect(out.displayName).toBeNull();
  });
});

describe("codebuddy-intl connection test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.updateProviderConnection.mockResolvedValue({});
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-cb-intl",
      provider: "codebuddy-intl",
      authType: "oauth",
      accessToken: makeJwt({ email: "aghiyaramadh@gmail.com", name: "aghiya ramadh" }),
      refreshToken: "rt",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      providerSpecificData: {},
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("probes the token instead of returning 'Provider test not supported'", async () => {
    const calls = [];
    global.fetch = vi.fn((url) => {
      calls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ email: "aghiyaramadh@gmail.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const result = await testSingleConnection("conn-cb-intl");

    expect(result.error).not.toBe("Provider test not supported");
    expect(result.valid).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    // Must hit a real identity/usage endpoint on the codebuddy.ai domain.
    expect(calls.some((u) => u.includes("codebuddy.ai"))).toBe(true);
  });

  it("marks the connection invalid on 401", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    );

    const result = await testSingleConnection("conn-cb-intl");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid|revoked/i);
  });
});
