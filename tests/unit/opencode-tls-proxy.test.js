// Locks the OpenCode free-tier transport wiring:
//  - the TLS client is cached per proxy (wreq-js takes `proxy` at session
//    creation only, so a rotating pool needs one session per proxy URL)
//  - `proxy` sits beside `emulation` in the session options, never inside it
//  - a 429 drops the cached session and retries once on a fresh one
//  - proxyFetch hands the resolved proxy to a directFetch that opted in, so the
//    impersonated ClientHello survives the tunnel (undici's ProxyAgent loses
//    it and the upstream answers 429 FreeUsageLimitError)
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createSessionMock, loadRuntimeDepMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  loadRuntimeDepMock: vi.fn(),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

describe("opencodeTlsFetch — proxy sessions", () => {
  beforeEach(async () => {
    vi.resetModules();
    createSessionMock.mockReset();
    loadRuntimeDepMock.mockReset();
    loadRuntimeDepMock.mockResolvedValue({ createSession: createSessionMock });
  });

  it("puts the proxy beside emulation, never inside it", async () => {
    createSessionMock.mockResolvedValue({ fetch: vi.fn().mockResolvedValue(new Response("ok")), close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "http://proxy.example.com:8080" });

    const options = createSessionMock.mock.calls[0][0];
    expect(options.proxy).toBe("http://proxy.example.com:8080");
    expect(options.emulation.proxy).toBeUndefined();
    expect(options.emulation.tlsOptions.cipherList).toBeTruthy();
  });

  it("caches one session per proxy URL", async () => {
    createSessionMock.mockResolvedValue({ fetch: vi.fn().mockResolvedValue(new Response("ok")), close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "http://p1:8080" });
    await opencodeTlsFetch("https://opencode.ai/b", {}, { proxyUrl: "http://p1:8080" });
    await opencodeTlsFetch("https://opencode.ai/c", {}, { proxyUrl: "http://p2:8080" });
    await opencodeTlsFetch("https://opencode.ai/d", {});

    expect(createSessionMock).toHaveBeenCalledTimes(3);
  });

  it("drops the session on 429 and retries once on a fresh one", async () => {
    const firstSession = { fetch: vi.fn().mockResolvedValue(new Response("busy", { status: 429 })), close: vi.fn() };
    const secondSession = { fetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })), close: vi.fn() };
    createSessionMock
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const controller = new AbortController();
    const result = await opencodeTlsFetch("https://opencode.ai/a", { body: "{}" }, { signal: controller.signal });

    expect(result.status).toBe(200);
    expect(createSessionMock).toHaveBeenCalledTimes(2);
    expect(firstSession.close).toHaveBeenCalled();
  });

  it("returns the 429 when the retry also fails", async () => {
    createSessionMock.mockResolvedValue({
      fetch: vi.fn().mockResolvedValue(new Response("busy", { status: 429 })),
      close: vi.fn(),
    });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const controller = new AbortController();
    const result = await opencodeTlsFetch("https://opencode.ai/a", { body: "{}" }, { signal: controller.signal });

    expect(result.status).toBe(429);
  });
});

describe("proxyFetch — directFetch proxy delegation", () => {
  it("hands the resolved proxy to a directFetch that opted in", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const seen = {};
    const directFetch = vi.fn(async (url, options, { proxyUrl } = {}) => {
      seen.proxyUrl = proxyUrl;
      return new Response("direct");
    });

    const response = await proxyAwareFetch(
      "https://opencode.ai/inference/v1/chat/completions",
      { directFetch, directFetchHandlesProxy: true },
      { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example.com:8080" }
    );

    expect(await response.text()).toBe("direct");
    expect(seen.proxyUrl).toBe("http://proxy.example.com:8080");
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the plain directFetch path untouched when no proxy is configured", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const directFetch = vi.fn(async () => new Response("direct"));

    const response = await proxyAwareFetch("https://opencode.ai/a", { directFetch }, null);

    expect(await response.text()).toBe("direct");
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(directFetch.mock.calls[0].length).toBeLessThan(3);
  });
});
