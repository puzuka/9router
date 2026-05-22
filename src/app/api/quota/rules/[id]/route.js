import { NextResponse } from "next/server";
import { deleteQuotaRule, getQuotaRule, updateQuotaRule } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const rule = await getQuotaRule(id);
    if (!rule) return NextResponse.json({ error: "Quota rule not found" }, { status: 404 });
    return NextResponse.json({ rule });
  } catch (error) {
    console.error("[quota/rules] get failed:", error);
    return NextResponse.json({ error: "Failed to fetch quota rule" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const rule = await updateQuotaRule(id, body);
    if (!rule) return NextResponse.json({ error: "Quota rule not found" }, { status: 404 });
    return NextResponse.json({ rule });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to update quota rule" }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteQuotaRule(id);
    if (!deleted) return NextResponse.json({ error: "Quota rule not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[quota/rules] delete failed:", error);
    return NextResponse.json({ error: "Failed to delete quota rule" }, { status: 500 });
  }
}
