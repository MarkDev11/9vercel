/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const lines = msg.split("\n").filter((l) => l.trim().startsWith("data:"));
  if (!eventMatch || lines.length === 0) return;

  const eventType = eventMatch[1].trim();

  for (const line of lines) {
    const dataStr = line.trim().slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    let parsed;
    try { parsed = JSON.parse(dataStr); }
    catch { continue; }
    handleResponsesEvent(eventType, parsed, state);
  }
}

function handleResponsesEvent(eventType, parsed, state) {
  if (eventType === "response.created" || eventType === "response.in_progress") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
    if (parsed.response?.model && !state.model) state.model = parsed.response.model;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.output_text.delta") {
    // Fallback path: some Responses backends (e.g. opencode zen) only ever emit
    // output_item.done for the reasoning item and a terminal response.completed
    // WITHOUT per-item payloads for the text message — the only place the
    // answer text appears is the delta events. Accumulate them so the
    // forced-SSE→JSON path can rebuild the assistant message.
    const idx = parsed.output_index ?? 1;
    const delta = typeof parsed.delta === "string" ? parsed.delta : "";
    if (delta) {
      const existing = state.items.get(idx);
      const prev = extractMessageText(existing);
      state.textDeltas = state.textDeltas || new Map();
      state.textDeltas.set(idx, (state.textDeltas.get(idx) || "") + delta);
      if (!existing) {
        state.items.set(idx, {
          id: parsed.item_id || `msg_delta_${idx}`,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text: (state.textDeltas.get(idx) || "") + prev }],
        });
      } else {
        appendDeltaToMessage(state.items, idx, delta);
      }
    }
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = parsed.response?.status && parsed.response.status !== "in_progress"
      ? parsed.response.status
      : "completed";
    const usage = parsed.response?.usage;
    if (usage && typeof usage === "object") {
      state.usage.input_tokens = usage.input_tokens || 0;
      state.usage.output_tokens = usage.output_tokens || 0;
      state.usage.total_tokens = usage.total_tokens || 0;
      if (usage.input_tokens_details && typeof usage.input_tokens_details === "object") {
        state.usage.input_tokens_details = usage.input_tokens_details;
      }
      if (usage.output_tokens_details && typeof usage.output_tokens_details === "object") {
        state.usage.output_tokens_details = usage.output_tokens_details;
      }
    }
    // Some backends omit usage on response.completed when the message item
    // itself was never emitted as output_item.done — merge the terminal
    // response.output payload (authoritative full items) if present.
    const terminalOutput = parsed.response?.output;
    if (Array.isArray(terminalOutput)) {
      for (let i = 0; i < terminalOutput.length; i++) {
        const item = terminalOutput[i];
        if (!item || typeof item !== "object") continue;
        // Prefer indexed placement: message items land after reasoning items.
        if (!state.items.has(i)) state.items.set(i, item);
      }
      // Merge delta-accumulated text into any message item that arrived empty.
      if (state.textDeltas) {
        for (const [idx, text] of state.textDeltas) {
          const item = state.items.get(idx);
          if (item && item.type === "message" && !extractMessageText(item) && text) {
            state.items.set(idx, {
              ...item,
              content: [{ type: "output_text", text, annotations: [] }],
            });
          }
        }
      }
    }
    if (parsed.response?.id) state.responseId = parsed.response.id;
    if (parsed.response?.model) state.model = parsed.response.model;
  } else if (eventType === "response.failed") {
    state.status = "failed";
  }
}

function extractMessageText(item) {
  if (!item || item.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content.map((c) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean).join("");
}

function appendDeltaToMessage(items, idx, delta) {
  const item = items.get(idx);
  if (!item || item.type !== "message" || !Array.isArray(item.content)) return;
  const textPart = item.content.find((c) => c && typeof c === "object" && typeof c.text === "string");
  if (textPart) textPart.text += delta;
  else item.content.push({ type: "output_text", text: delta, annotations: [] });
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  const result = {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "completed",
    output,
    usage: state.usage
  };
  if (state.model) result.model = state.model;
  return result;
}
