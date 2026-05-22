import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { listQuotaRules } from "@/lib/localDb";
import { getApiKeyRecentRequests, getApiKeyUsageSummary, getChartData, getUsageStats } from "@/lib/usageDb";

const PERIOD_ALIASES = { "7day": "7d", "30day": "30d" };
const VALID_PERIODS = new Set(["today", "24h", "7d", "30d"]);

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const requestedPeriod = searchParams.get("period") || "today";
    const period = PERIOD_ALIASES[requestedPeriod] || requestedPeriod;
    const tzOffsetMinutes = Number(searchParams.get("tzOffsetMinutes"));

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const [stats, summary, chart, requests, quotaRules] = await Promise.all([
      getUsageStats({ period, apiKey: key.key }),
      getApiKeyUsageSummary(key.key, period, { tzOffsetMinutes }),
      getChartData({ period, apiKey: key.key, tzOffsetMinutes }),
      getApiKeyRecentRequests(key.key, period, 20),
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

    return NextResponse.json({
      key: { id: key.id, name: key.name, isActive: key.isActive, createdAt: key.createdAt },
      period: requestedPeriod,
      stats,
      chart,
      requests,
      quotas,
    });
  } catch (error) {
    console.error("[API] Failed to get API key usage:", error);
    return NextResponse.json({ error: "Failed to fetch API key usage" }, { status: 500 });
  }
}
