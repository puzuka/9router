import { NextResponse } from "next/server";
import { getProviderUsageBreakdown } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "all"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "today";
    const provider = searchParams.get("provider") || null;
    const tzOffsetMinutes = Number(searchParams.get("tzOffsetMinutes"));

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const stats = await getProviderUsageBreakdown({
      period,
      provider,
      tzOffsetMinutes: Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : undefined,
    });

    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get provider usage breakdown:", error);
    return NextResponse.json({ error: "Failed to fetch provider usage breakdown" }, { status: 500 });
  }
}
