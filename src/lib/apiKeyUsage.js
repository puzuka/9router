import { listQuotaRules } from "@/lib/localDb";
import { getApiKeyRecentRequests, getApiKeyUsageSummary, getChartData, getUsageStats } from "@/lib/usageDb";

export const API_KEY_USAGE_PERIOD_ALIASES = { "7day": "7d", "30day": "30d" };
export const VALID_API_KEY_USAGE_PERIODS = new Set(["today", "24h", "7d", "30d"]);

export function normalizeApiKeyUsagePeriod(requestedPeriod = "today") {
  return API_KEY_USAGE_PERIOD_ALIASES[requestedPeriod] || requestedPeriod;
}

export async function getApiKeyUsagePayload(key, options = {}) {
  const requestedPeriod = options.requestedPeriod || "today";
  const period = normalizeApiKeyUsagePeriod(requestedPeriod);
  const tzOffsetMinutes = Number(options.tzOffsetMinutes);

  const [stats, summary, chart, requests, quotaRules] = await Promise.all([
    getUsageStats({ period, apiKey: key.key }),
    getApiKeyUsageSummary(key.key, period, { tzOffsetMinutes }),
    getChartData({ period, apiKey: key.key, tzOffsetMinutes }),
    getApiKeyRecentRequests(key.key, period, options.requestLimit || 20),
    listQuotaRules({ includeUsage: true, tzOffsetMinutes }),
  ]);
  Object.assign(stats, summary);

  const quotas = quotaRules
    .filter((rule) => rule.enabled && rule.scopeType === "apiKey" && rule.scopeId === key.id && ["promptTokens", "completionTokens", "totalTokens", "cost"].includes(rule.metric))
    .map((rule) => ({
      id: rule.id,
      metric: rule.metric,
      period: rule.period,
      limitValue: rule.limitValue,
      used: rule.usage?.used || 0,
      remaining: Math.max(0, rule.limitValue - (rule.usage?.used || 0)),
      percentUsed: rule.limitValue > 0 ? Math.min(100, ((rule.usage?.used || 0) / rule.limitValue) * 100) : 0,
      resetAt: rule.usage?.resetAt || null,
      overLimit: (rule.usage?.used || 0) >= rule.limitValue,
    }));

  return {
    key: { id: key.id, name: key.name, isActive: key.isActive, createdAt: key.createdAt },
    period: requestedPeriod,
    stats,
    chart,
    requests,
    quotas,
  };
}
