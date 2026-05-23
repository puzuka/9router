import { NextResponse } from "next/server";
import { createProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";
import { extractCodexAccountInfo } from "@/lib/oauth/providers";

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;

    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeSessions(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.sessions)) return body.sessions;
  return [body];
}

function getAccessToken(session) {
  if (typeof session === "string") return session.trim();
  if (!session || typeof session !== "object") return "";
  return typeof session.accessToken === "string"
    ? session.accessToken.trim()
    : (typeof session.access_token === "string" ? session.access_token.trim() : "");
}

function getExpiresAt(session, payload) {
  try {
    if (payload?.exp) return new Date(payload.exp * 1000).toISOString();
    if (session && typeof session === "object" && session.expires) {
      const date = new Date(session.expires);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  } catch {
    return null;
  }
  return null;
}

function getSessionUser(session) {
  if (!session || typeof session !== "object" || !session.user || typeof session.user !== "object") {
    return {};
  }
  return session.user;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== "")
  );
}

function findExistingConnection(connections, email, chatgptAccountId) {
  return connections.find((connection) => {
    if (connection.provider !== "codex" || connection.authType !== "oauth") return false;

    const existingAccountId = connection.providerSpecificData?.chatgptAccountId;
    if (chatgptAccountId && existingAccountId) {
      return existingAccountId === chatgptAccountId;
    }

    if (email && connection.email) {
      return connection.email === email;
    }

    return false;
  });
}

/**
 * POST /api/oauth/codex/import-session
 * Import Codex accounts from ChatGPT session JSON.
 *
 * Supported bodies:
 * - { accessToken, user?, expires? }
 * - [{ accessToken, user?, expires? }]
 * - { sessions: [{ accessToken, user?, expires? }] }
 * - "raw-access-token"
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const sessions = normalizeSessions(body);

    if (sessions.length === 0) {
      return NextResponse.json({ error: "No sessions provided" }, { status: 400 });
    }

    const results = [];
    const errors = [];
    const existingConnections = await getProviderConnections({ provider: "codex" });

    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index];
      const accessToken = getAccessToken(session);

      if (!accessToken) {
        errors.push({ index, error: "Missing accessToken" });
        continue;
      }

      const payload = decodeJwtPayload(accessToken);
      const accountInfo = extractCodexAccountInfo(accessToken);
      const user = getSessionUser(session);
      const email = accountInfo.email || user.email || payload?.preferred_username || payload?.sub || null;
      const displayName = user.name || user.username || null;
      const expiresAt = getExpiresAt(session, payload);
      const providerSpecificData = compactObject({
        chatgptAccountId: accountInfo.chatgptAccountId,
        chatgptPlanType: accountInfo.chatgptPlanType,
        importMethod: "session",
      });

      try {
        const existing = findExistingConnection(existingConnections, email, accountInfo.chatgptAccountId);
        const connectionData = {
          provider: "codex",
          authType: "oauth",
          accessToken,
          ...(expiresAt ? { expiresAt } : {}),
          ...(email ? { email } : {}),
          ...(displayName ? { displayName } : {}),
          ...(Object.keys(providerSpecificData).length ? { providerSpecificData } : {}),
          testStatus: "active",
          isActive: true,
        };
        const connection = existing
          ? await updateProviderConnection(existing.id, {
              ...connectionData,
              providerSpecificData: {
                ...(existing.providerSpecificData || {}),
                ...(connectionData.providerSpecificData || {}),
              },
            })
          : await createProviderConnection(connectionData);

        if (!existing) existingConnections.push(connection);

        results.push({
          index,
          connectionId: connection.id,
          email: connection.email || email,
          plan: accountInfo.chatgptPlanType || null,
        });
      } catch (error) {
        errors.push({ index, email, error: error.message });
      }
    }

    return NextResponse.json({
      success: results.length > 0,
      imported: results.length,
      failed: errors.length,
      connections: results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.log("Codex session import error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
