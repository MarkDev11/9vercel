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

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {  
  // Fallback to local handling
  const handleChat = await loadChatPipeline();
  
  return await handleChat(request);
}

