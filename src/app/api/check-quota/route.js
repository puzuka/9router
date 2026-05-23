import { NextResponse } from "next/server";
import { getApiKeyByKey } from "@/lib/localDb";
import { getApiKeyUsagePayload, normalizeApiKeyUsagePeriod, VALID_API_KEY_USAGE_PERIODS } from "@/lib/apiKeyUsage";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    const { apiKey, period: requestedPeriod = "today", tzOffsetMinutes } = body;
    const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";

    if (!normalizedApiKey) {
      return NextResponse.json({ error: "API key is required" }, { status: 400 });
    }

    const key = await getApiKeyByKey(normalizedApiKey);
    if (!key) {
      return NextResponse.json({ error: "Invalid API key" }, { status: 404 });
    }

    if (!key.isActive) {
      return NextResponse.json({ error: "API key is disabled" }, { status: 403 });
    }

    const period = normalizeApiKeyUsagePeriod(requestedPeriod);
    if (!VALID_API_KEY_USAGE_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    return NextResponse.json(await getApiKeyUsagePayload(key, { requestedPeriod, tzOffsetMinutes }));
  } catch (error) {
    console.error("[API] Failed to check quota:", error);
    return NextResponse.json({ error: "Failed to fetch API key usage" }, { status: 500 });
  }
}
