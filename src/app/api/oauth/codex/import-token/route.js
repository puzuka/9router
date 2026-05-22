import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/codex/import-token
 * Import an exported Codex JSON object as a provider connection.
 * Email in the JSON becomes the connection name/email.
 * The original JSON is stored under providerSpecificData.importedJson.
 */
export async function POST(request) {
  try {
    const importedJson = await request.json();

    if (!importedJson || typeof importedJson !== "object" || Array.isArray(importedJson)) {
      return NextResponse.json({ error: "Codex JSON object is required" }, { status: 400 });
    }

    const email = typeof importedJson.email === "string" ? importedJson.email.trim() : "";
    if (!email) {
      return NextResponse.json({ error: "Email is required in Codex JSON" }, { status: 400 });
    }

    const accessToken = typeof importedJson.accessToken === "string" ? importedJson.accessToken.trim() : "";
    if (!accessToken) {
      return NextResponse.json({ error: "Access token is required in Codex JSON" }, { status: 400 });
    }

    const providerSpecificData = {
      authMethod: "json_import",
      ...(importedJson.providerSpecificData && typeof importedJson.providerSpecificData === "object" ? importedJson.providerSpecificData : {}),
      importedJson,
    };

    const connection = await createProviderConnection({
      provider: "codex",
      authType: "oauth",
      accessToken,
      name: email,
      email,
      providerSpecificData,
      testStatus: "unknown",
      isActive: true,
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        name: connection.name,
        workspace: providerSpecificData.chatgptAccountId || null,
        plan: providerSpecificData.chatgptPlanType || null,
      },
    });
  } catch (error) {
    console.log("Codex access token import error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
