import { NextResponse } from "next/server";
import { createQuotaRule, getQuotaTargets, listQuotaRules } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [rules, targets] = await Promise.all([
      listQuotaRules({ includeUsage: true }),
      getQuotaTargets(),
    ]);
    return NextResponse.json({ rules, targets });
  } catch (error) {
    console.error("[quota/rules] list failed:", error);
    return NextResponse.json({ error: "Failed to fetch quota rules" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const rule = await createQuotaRule(body);
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to create quota rule" }, { status: 400 });
  }
}
