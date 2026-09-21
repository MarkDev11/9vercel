// Freebuff provider (ported from MIBP fork): wire-shape unit tests.
// No network: transformRequest only (session/run registration needs live creds).
import { describe, it, expect } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import { __test__ } from "../../open-sse/executors/freebuff.js";

const CREDS = { accessToken: "test-token", providerSpecificData: {} };

describe("freebuff transformRequest", () => {
  it("resolves the specialized executor", () => {
    expect(getExecutor("freebuff").constructor.name).toBe("FreebuffExecutor");
  });

  it("attaches codebuff_metadata + provider block, strips reasoning", () => {
    const ex = getExecutor("freebuff");
    const out = ex.transformRequest("z-ai/glm-5.3-flash", {
      model: "z-ai/glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      reasoning: { effort: "high" },
    }, true, CREDS);
    expect(out.codebuff_metadata.cost_mode).toBe("free");
    expect(out.codebuff_metadata.client_id).toBeTruthy();
    expect(out.provider).toEqual({ allow_fallbacks: false });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning).toBeUndefined();
  });

  it("prepends the canonical Buffy system marker idempotently", () => {
    const ex = getExecutor("freebuff");
    const once = ex.transformRequest("mimo/mimo-v2.5", {
      model: "mimo/mimo-v2.5",
      messages: [{ role: "user", content: "hi" }],
    }, true, CREDS);
    expect(once.messages[0].role).toBe("system");
    expect(once.messages[0].content.startsWith("You are Buffy, the strategic coding assistant.")).toBe(true);
    const twice = ex.transformRequest("mimo/mimo-v2.5", once, true, CREDS);
    expect(twice.messages.filter((m) => m.role === "system").length).toBe(1);
  });

  it("injects end_turn tool only when tools are declared", () => {
    const ex = getExecutor("freebuff");
    const noTools = ex.transformRequest("mimo/mimo-v2.5", {
      model: "mimo/mimo-v2.5",
      messages: [{ role: "user", content: "hi" }],
    }, true, CREDS);
    expect(noTools.tools).toBeUndefined();
    const withTools = ex.transformRequest("mimo/mimo-v2.5", {
      model: "mimo/mimo-v2.5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_time", parameters: {} } }],
    }, true, CREDS);
    expect(withTools.tools.map((t) => t.function.name)).toEqual(["get_time", "end_turn"]);
  });

  it("maps known models to base3 roots, unknown to base2-free", () => {
    expect(__test__.rootAgentIdForModel("z-ai/glm-5.3-flash")).toBe("base3-free-glm-5-3-flash");
    expect(__test__.rootAgentIdForModel("something/else")).toBe("base2-free");
  });

  it("prunes state without throwing", () => {
    expect(() => __test__.resetSessionCache()).not.toThrow();
    expect(__test__.pruneSessionState(Date.now())).toBe(0);
  });
});
