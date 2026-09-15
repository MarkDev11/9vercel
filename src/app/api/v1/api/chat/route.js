import { transformToOllama } from "open-sse/utils/ollamaTransform.js";

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

export async function POST(request) {
  const handleChat = await loadChatPipeline();
  
  const clonedReq = request.clone();
  let modelName = "llama3.2";
  try {
    const body = await clonedReq.json();
    modelName = body.model || "llama3.2";
  } catch {}

  const response = await handleChat(request);
  return transformToOllama(response, modelName);
}

