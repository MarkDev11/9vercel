import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { convertResponsesStreamToJson } = await import("../../open-sse/transformer/streamToJsonConverter.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

// Real opencode zen framing (captured live 2026-09-04): `event:` + `data:`
// pairs separated by blank lines; the answer text rides in a single
// response.output_text.delta plus the terminal response.completed payload.
function zenStreamText() {
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}`;
  return [
    ev("response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_test1", object: "response", created_at: 1788502850, status: "in_progress" } }),
    ev("response.in_progress", { type: "response.in_progress", sequence_number: 1, response: { id: "resp_test1", object: "response", status: "in_progress" } }),
    ev("response.output_item.added", { type: "response.output_item.added", sequence_number: 2, output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress", summary: [] } }),
    ev("response.output_item.done", { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "rs_1", type: "reasoning", status: "completed", encrypted_content: "Q-secret" } }),
    ev("response.output_item.added", { type: "response.output_item.added", sequence_number: 4, output_index: 1, item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] } }),
    ev("response.content_part.added", { type: "response.content_part.added", sequence_number: 5, output_index: 1, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "", annotations: [] } }),
    ev("response.output_text.delta", { type: "response.output_text.delta", sequence_number: 6, output_index: 1, content_index: 0, item_id: "msg_1", delta: "BEARER_OK", logprobs: [] }),
    ev("response.content_part.done", { type: "response.content_part.done", sequence_number: 7, output_index: 1, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "BEARER_OK", annotations: [] } }),
    ev("response.output_item.done", { type: "response.output_item.done", sequence_number: 9, output_index: 1, item: { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "BEARER_OK", annotations: [] }] } }),
    ev("response.completed", { type: "response.completed", sequence_number: 10, response: { id: "resp_test1", object: "response", status: "completed", model: "muse-spark-1.3-contributor-free", output: [{ id: "rs_1", type: "reasoning", status: "completed", encrypted_content: "Q-secret" }, { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "BEARER_OK", annotations: [] }] }], usage: { input_tokens: 42, output_tokens: 17, total_tokens: 59 } } }),
    ev("ping", { type: "ping", cost: "0" }),
    ""
  ].join("\n\n");
}

// Degraded variant: the message output_item.done never arrives (only the
// reasoning done + deltas + terminal payload). The converter must still
// rebuild the answer from deltas.
function zenStreamTextSparse() {
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}`;
  return [
    ev("response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_sparse", object: "response", created_at: 1788502850, status: "in_progress" } }),
    ev("response.output_item.done", { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "rs_1", type: "reasoning", status: "completed", encrypted_content: "Q-secret" } }),
    ev("response.output_text.delta", { type: "response.output_text.delta", sequence_number: 6, output_index: 1, content_index: 0, item_id: "msg_1", delta: "BEARER", logprobs: [] }),
    ev("response.output_text.delta", { type: "response.output_text.delta", sequence_number: 7, output_index: 1, content_index: 0, item_id: "msg_1", delta: "_OK", logprobs: [] }),
    ev("response.completed", { type: "response.completed", sequence_number: 8, response: { id: "resp_sparse", object: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }),
    ""
  ].join("\n\n");
}

function sseResponse(text) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); }
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

function forcedCtx(text, sourceFormat = FORMATS.OPENAI, targetFormat = FORMATS.OPENAI_RESPONSES) {
  return {
    providerResponse: sseResponse(text),
    sourceFormat,
    targetFormat,
    provider: "opencode",
    model: "muse-spark-1.3-contributor-free",
    body: { model: "oc/muse-spark-1.3-contributor-free", messages: [] },
    stream: false,
    translatedBody: { model: "muse-spark-1.3-contributor-free", input: [], stream: true, store: false },
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn()
  };
}

describe("opencode zen Responses SSE framing (live capture)", () => {
  it("converter keeps the message item, usage, and model", async () => {
    const out = await convertResponsesStreamToJson(sseResponse(zenStreamText()).body);
    expect(out.status).toBe("completed");
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(JSON.stringify(msg.content)).toContain("BEARER_OK");
    expect(out.usage).toMatchObject({ input_tokens: 42, output_tokens: 17, total_tokens: 59 });
    expect(out.model).toBe("muse-spark-1.3-contributor-free");
  });

  it("converter rebuilds text from deltas when message done is missing", async () => {
    const out = await convertResponsesStreamToJson(sseResponse(zenStreamTextSparse()).body);
    const msg = (out.output || []).find((o) => o.type === "message");
    expect(msg).toBeTruthy();
    expect(JSON.stringify(msg.content)).toContain("BEARER_OK");
    expect(out.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it("forced-SSE path returns chat.completion with content + usage for an OpenAI client", async () => {
    const result = await handleForcedSSEToJson(forcedCtx(zenStreamText()));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("BEARER_OK");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage).toMatchObject({ prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 });
  });

  it("forced-SSE path recovers content from the sparse variant too", async () => {
    const result = await handleForcedSSEToJson(forcedCtx(zenStreamTextSparse()));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("BEARER_OK");
    expect(json.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("non-stream JSON path converts a Responses body into chat.completion", () => {
    const out = translateNonStreamingResponse(
      {
        id: "resp_test1",
        object: "response",
        created_at: 1788502850,
        model: "muse-spark-1.3-contributor-free",
        status: "completed",
        output: [
          { id: "rs_1", type: "reasoning", status: "completed" },
          { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "BEARER_OK" }] }
        ],
        usage: { input_tokens: 42, output_tokens: 17, total_tokens: 59 }
      },
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI
    );
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("BEARER_OK");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage).toMatchObject({ prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 });
  });
});
