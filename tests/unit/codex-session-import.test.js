import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

function base64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(payload) {
  return `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url(payload)}.signature`;
}

function makeRequest(body) {
  return new Request("https://9router.local/api/oauth/codex/import-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function resetDbAdapter() {
  globalThis._dbAdapter?.instance?.close?.();
  delete globalThis._dbAdapter;
}

async function setupTestContext() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-codex-session-import-"));
  process.env.DATA_DIR = tempDir;
  resetDbAdapter();
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  const { POST } = await import("@/app/api/oauth/codex/import-session/route.js");
  const { createProviderConnection, getProviderConnections } = await import("@/models/index.js");

  return {
    POST,
    createProviderConnection,
    getProviderConnections,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("Codex session import API", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    resetDbAdapter();
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("imports a ChatGPT session as a Codex OAuth connection", async () => {
    const ctx = await setupTestContext();
    cleanup = ctx.cleanup;

    const exp = 1790000000;
    const accessToken = makeJwt({
      email: "codex@example.com",
      sub: "user-sub",
      exp,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
        chatgpt_plan_type: "plus",
      },
    });

    const response = await ctx.POST(makeRequest({
      accessToken,
      user: { name: "Codex User" },
      expires: "2030-01-01T00:00:00.000Z",
    }));
    const body = await response.json();
    const connections = await ctx.getProviderConnections({ provider: "codex" });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      imported: 1,
      failed: 0,
      connections: [{ email: "codex@example.com", plan: "plus" }],
    });
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      provider: "codex",
      authType: "oauth",
      accessToken,
      email: "codex@example.com",
      displayName: "Codex User",
      expiresAt: new Date(exp * 1000).toISOString(),
      providerSpecificData: {
        chatgptAccountId: "account-123",
        chatgptPlanType: "plus",
        importMethod: "session",
      },
      testStatus: "active",
    });
  });

  it("supports sessions arrays and reports missing token entries", async () => {
    const ctx = await setupTestContext();
    cleanup = ctx.cleanup;

    const accessToken = makeJwt({
      preferred_username: "fallback@example.com",
      exp: 1790000000,
    });

    const response = await ctx.POST(makeRequest({
      sessions: [
        {},
        { access_token: accessToken },
      ],
    }));
    const body = await response.json();
    const connections = await ctx.getProviderConnections({ provider: "codex" });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      imported: 1,
      failed: 1,
      errors: [{ index: 0, error: "Missing accessToken" }],
    });
    expect(connections).toHaveLength(1);
    expect(connections[0].email).toBe("fallback@example.com");
  });

  it("updates matching Codex sessions without clearing refresh token or metadata", async () => {
    const ctx = await setupTestContext();
    cleanup = ctx.cleanup;

    await ctx.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      accessToken: "old-access",
      refreshToken: "keep-refresh-token",
      email: "codex@example.com",
      providerSpecificData: {
        chatgptAccountId: "account-123",
        proxyPoolId: "pool-1",
      },
      testStatus: "active",
    });

    const accessToken = makeJwt({
      email: "codex@example.com",
      exp: 1790000000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
        chatgpt_plan_type: "plus",
      },
    });

    const response = await ctx.POST(makeRequest({ accessToken }));
    const body = await response.json();
    const connections = await ctx.getProviderConnections({ provider: "codex" });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, imported: 1, failed: 0 });
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      accessToken,
      refreshToken: "keep-refresh-token",
      providerSpecificData: {
        chatgptAccountId: "account-123",
        chatgptPlanType: "plus",
        importMethod: "session",
        proxyPoolId: "pool-1",
      },
    });
  });
});
