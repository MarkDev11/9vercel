/**
 * Freebuff — the free, ad-supported coding agent by Codebuff (freebuff.com).
 *
 * The Freebuff CLI (github.com/CodebuffAI/freebuff) is an interactive TUI that
 * talks to the Codebuff/Freebuff backend. Two hosts are involved:
 *   - login flow (freebuff mode) runs on  https://freebuff.com
 *       POST /api/auth/cli/code {fingerprintId} → { loginUrl, fingerprintHash, expiresAt }
 *       open loginUrl in browser, then GET /api/auth/cli/status until {user}.
 *       (The server echoes the request host into loginUrl, so calling
 *       freebuff.com yields freebuff.com/login?auth_code=… exactly like the
 *       official CLI — www.codebuff.com would yield the wrong link.)
 *   - LLM traffic goes to the OpenAI-compatible endpoint on
 *       https://www.codebuff.com/api/v1/chat/completions
 *     (freebuff.com does NOT serve /api/v1/* — it 404s with the SPA shell.)
 *
 * Both hosts share one backend: the authToken obtained via the freebuff.com
 * login validates against www.codebuff.com (Bearer auth). The request body
 * must carry the CLI's `codebuff` provider block
 * (`codebuff_metadata.run_id/client_id/cost_mode`) — injected by
 * executors/freebuff.js. cost_mode:"free" is what admits a session on the free
 * (country-gated, session-limited) tier instead of billing credits.
 */
export default {
  id: "freebuff",
  priority: 45,
  hasFree: true,
  alias: "fb",
  uiAlias: "fb",
  display: {
    name: "Freebuff",
    icon: "bolt",
    color: "#84CC16",
    textIcon: "FB",
    website: "https://freebuff.com",
    notice: {
      signupUrl: "https://freebuff.com",
      text: "Free ad-supported coding agent by Codebuff. Sign in with your Freebuff/Codebuff account via browser login. Each model is priced in Freebucks per hour of session, charged once when the session starts. Your daily Freebucks refill at midnight Pacific; the wallet keeps what you buy or earn. Free tier is ad-supported and limited in some regions (limited mode: 6 x 1-hour sessions/day); full mode runs in select countries. ⚠️ One account has ONE active session locked to ONE model — requesting a different model while a session is active returns 'model_locked' (409); use a separate account per model, or wait for the session to expire.",
    },
  },
  category: "free",
  authType: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
    headers: {
      "User-Agent": "ai-sdk/openai-compatible/1.0/codebuff",
    },
    retry: {
      429: { attempts: 2, delayMs: 2000 },
      503: { attempts: 2, delayMs: 1500 },
    },
    // Session endpoint doubles as the quota API: GET /api/v1/freebuff/session
    // returns the shared daily session quota (rateLimitsByModel) without
    // claiming anything — POST would burn a session, so quota reads are GET
    // only (see services/usage/freebuff.js).
    usage: {
      url: "https://www.codebuff.com/api/v1/freebuff/session",
    },
  },
  features: {
    usage: true,
  },
  // Mirrors the Freebuff waiting-room picker (upstream FREEBUFF_MODELS).
  // NO per-model prices live here: Freebucks pricing is server-authoritative.
  // deepseek-v4-pro and minimax-m3 were withdrawn upstream and ox-alpha +
  // gemini-3.8-flash never stuck — none are claimable anymore.
  // z-ai/glm-5.2 is a referral reward (not a free pick), luna-es / kimi-k3-eco
  // are god-only rows, and the `-max` variants are provisioned per-account —
  // all intentionally omitted. Fable is a capacity-limited WAVE trial: sessions
  // only claim while the backend advertises it via limitedModelOffers on the
  // session status (the executor auto-checks before claiming).
  // meta/muse-spark-1.3-contributor was withdrawn upstream and replaced in the
  // picker by meta/muse-spark-1.2-contributor — 1.3 is intentionally NOT listed.
  // deepseek/deepseek-v4-flash was RENAMED upstream to DeepSeek V4.1 Flash.
  models: [
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4.1 Flash" },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "mimo/mimo-v2.5", name: "MiMo 2.5" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4" },
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2" },
    { id: "anthropic/claude-fable-5", name: "Claude Fable 5 (limited offer)" },
  ],
  // Login-flow host — the CLI in freebuff mode logs in via freebuff.com, and
  // the server builds loginUrl from the host it was called on, so the link the
  // user opens must come from freebuff.com to match the official CLI.
  oauth: {
    baseUrl: "https://freebuff.com",
    loginCodePath: "/api/auth/cli/code",
    loginStatusPath: "/api/auth/cli/status",
    oauthTimeoutMs: 300000,
  },
};
