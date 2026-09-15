/**
 * Lazily load the heavy chat pipeline (open-sse translators + handlers).
 * Keeps this function's cold-start module graph small so CORS preflights and
 * the first request don't pay ~22 translator modules + provider registry up
 * front. Dynamic import() is cached, so warm hits stay cheap.
 */
async function loadChatPipeline() {
  const [{ handleChat }, translator] = await Promise.all([
    import("@/sse/handlers/chat.js"),
    import("open-sse/translator/index.js"),
  ]);
  await translator.initTranslators();
  return handleChat;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/responses/compact - Compact conversation context
 * Reuses the same handleChat pipeline, signals compact via body._compact
 */
export async function POST(request) {
  const handleChat = await loadChatPipeline();
  const body = await request.json();
  body._compact = true;
  const newRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body)
  });
  return await handleChat(newRequest);
}
