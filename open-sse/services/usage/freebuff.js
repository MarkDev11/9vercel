/**
 * Freebuff usage handler
 *
 * Freebuff has no separate billing/quota API — the daily free/premium session
 * quota lives on the session endpoint itself. Reading it MUST use
 * GET /api/v1/freebuff/session (POST would CLAIM a session and burn 1.0 unit
 * of the daily quota, which a quota tracker must never do).
 *
 * Freebucks-metered accounts get NO pool rows: the server sends a `freebucks`
 * block instead. Pricing is SERVER-AUTHORITATIVE and nothing here hardcodes a
 * number.
 */

import REGISTRY from "../../providers/registry/index.js";
import { U, fetchWithTimeout } from "./shared.js";

const freebuffRegistry = REGISTRY.find((r) => r.id === "freebuff") || {};
const MODEL_LABELS = Object.fromEntries(
  (freebuffRegistry.models || []).map((m) => [m.id, m.name]),
);

function applyFreebucksPriceChanges(info) {
  const now = Date.now();
  const due = (info?.priceChanges || []).filter((c) => Date.parse(c.at) <= now);
  if (due.length === 0) return info;
  const prices = { ...(info.prices || {}) };
  const priceNotices = { ...(info.priceNotices || {}) };
  for (const change of due.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (prices[change.modelId] === undefined) continue;
    prices[change.modelId] = change.price;
    priceNotices[change.modelId] = change.tagline;
  }
  return {
    ...info,
    prices,
    priceNotices,
    priceChanges: (info.priceChanges || []).filter((c) => Date.parse(c.at) > now),
  };
}

function sessionUrl() {
  return U("freebuff").url;
}

export async function getFreebuffUsage(accessToken, providerSpecificData, proxyOptions = null) {
  if (!accessToken) {
    return { message: "Freebuff credential not available — connect a Freebuff login first." };
  }

  try {
    const response = await fetchWithTimeout(
      sessionUrl(),
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "codebuff-cli/0.0.138",
          Accept: "application/json",
        },
      },
      15000,
      proxyOptions,
    );

    if (response.status === 401) {
      return { message: "Freebuff credential invalid or expired — re-login in the dashboard." };
    }
    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      if (body?.status === "country_blocked") {
        return { message: "Freebuff is not available in your region." };
      }
      if (body?.status === "banned") {
        return { message: "Your Freebuff account has been banned." };
      }
      return {
        message: `Freebuff quota access denied (403)${body?.message ? `: ${body.message}` : ""}.`,
      };
    }
    if (response.status === 404) {
      return { plan: "Freebuff", message: "Freebuff connected. No session quota to report right now." };
    }
    if (!response.ok) {
      return { message: `Freebuff quota API error (${response.status}).` };
    }

    const data = await response.json().catch(() => ({}));
    const rateLimits = { ...(data.rateLimitsByModel || {}) };
    if (data.status === "active" && data.rateLimit && !rateLimits[data.model]) {
      rateLimits[data.model] = data.rateLimit;
    }

    const quotas = {};
    for (const [model, rl] of Object.entries(rateLimits)) {
      if (!rl || typeof rl !== "object") continue;
      const used = Number(rl.recentCount);
      const total = Number(rl.limit);
      quotas[model] = {
        used: Number.isFinite(used) ? used : 0,
        total: Number.isFinite(total) ? total : 0,
        resetAt: rl.resetAt || null,
        unlimited: false,
        recurring: true,
        ...(MODEL_LABELS[model] ? { displayName: MODEL_LABELS[model] } : {}),
      };
    }

    let freebucksSummary = null;
    const rawFreebucks = data.freebucks;
    if (rawFreebucks && rawFreebucks.daily && typeof rawFreebucks.daily === "object") {
      const freebucks = applyFreebucksPriceChanges(rawFreebucks);
      const spent = Number(freebucks.daily.spent);
      const limit = Number(freebucks.daily.limit);
      for (const [model, price] of Object.entries(freebucks.prices || {})) {
        quotas[model] = {
          used: Number.isFinite(spent) ? spent : 0,
          total: Number.isFinite(limit) ? limit : 0,
          resetAt: freebucks.daily.resetAt || null,
          unlimited: false,
          recurring: true,
          price: Number.isFinite(Number(price)) ? Number(price) : undefined,
          ...(freebucks.priceNotices?.[model] ? { priceNote: freebucks.priceNotices[model] } : {}),
          ...(MODEL_LABELS[model] ? { displayName: MODEL_LABELS[model] } : {}),
        };
      }
      freebucksSummary = {
        balance: Number.isFinite(Number(freebucks.balance)) ? Number(freebucks.balance) : null,
        daily: {
          limit: Number.isFinite(limit) ? limit : 0,
          spent: Number.isFinite(spent) ? spent : 0,
          remaining: Number.isFinite(Number(freebucks.daily.remaining)) ? Number(freebucks.daily.remaining) : 0,
          resetAt: freebucks.daily.resetAt || null,
        },
        wallet: {
          balance: Number.isFinite(Number(freebucks.wallet?.balance)) ? Number(freebucks.wallet.balance) : 0,
        },
        ...(freebucks.monthly && Number.isFinite(Number(freebucks.monthly.remainingUsd))
          ? {
              monthly: {
                remainingUsd: Number(freebucks.monthly.remainingUsd),
                limitUsd: Number.isFinite(Number(freebucks.monthly.limitUsd)) ? Number(freebucks.monthly.limitUsd) : null,
                resetAt: freebucks.monthly.resetAt || null,
              },
            }
          : {}),
      };
    }

    const plan = data.accessTier === "limited" ? "Freebuff (Limited)" : "Freebuff";
    if (Object.keys(quotas).length === 0) {
      return { plan, message: "Freebuff connected. No session quota to report right now." };
    }
    const out = { plan, quotas };
    if (freebucksSummary) out.freebucks = freebucksSummary;
    return out;
  } catch (error) {
    return { message: `Freebuff usage error: ${error.message}` };
  }
}

export default getFreebuffUsage;
