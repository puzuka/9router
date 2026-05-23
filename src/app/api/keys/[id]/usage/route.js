import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { getApiKeyUsagePayload, normalizeApiKeyUsagePeriod, VALID_API_KEY_USAGE_PERIODS } from "@/lib/apiKeyUsage";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const requestedPeriod = searchParams.get("period") || "today";
    const period = normalizeApiKeyUsagePeriod(requestedPeriod);
    const tzOffsetMinutes = Number(searchParams.get("tzOffsetMinutes"));

    if (!VALID_API_KEY_USAGE_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    return NextResponse.json(await getApiKeyUsagePayload(key, { requestedPeriod, tzOffsetMinutes }));
  } catch (error) {
    console.error("[API] Failed to get API key usage:", error);
    return NextResponse.json({ error: "Failed to fetch API key usage" }, { status: 500 });
  }
}
