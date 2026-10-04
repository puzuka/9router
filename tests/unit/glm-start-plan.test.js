import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import glmStartProvider from "../../src/lib/oauth/providers/glm-start.js";
import { getProvider } from "../../src/lib/oauth/providers";
import { PROVIDERS as TRANSPORTS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";

const JWT = "zcode-jwt-abc";
const GATEWAY = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("glm-start registry entry (Z.ai Start Plan)", () => {
  it("targets the ZCode plan gateway, not api.z.ai", () => {
    expect(TRANSPORTS["glm-start"].baseUrl).toBe(GATEWAY);
    expect(TRANSPORTS["glm-start"].format).toBe("claude");
    expect(PROVIDER_OAUTH["glm-start"].planKind).toBe("start-plan");
  });

  it("declares the ZCode source headers the gateway fingerprints", () => {
    const headers = TRANSPORTS["glm-start"].headers;
    expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(headers["X-Title"]).toBe("Z Code@electron");
    expect(headers["User-Agent"]).toMatch(/^ZCode\//);
    expect(headers["X-ZCode-App-Version"]).toMatch(/^\d/);
  });

  it("is wired into the generic OAuth provider registry", () => {
    expect(getProvider("glm-start")).toBe(glmStartProvider);
    expect(glmStartProvider.config.planKind).toBe("start-plan");
  });
});

describe("glm-start request auth", () => {
  it("sends the ZCode JWT as both x-api-key and Bearer", () => {
    const headers = new DefaultExecutor("glm-start").buildHeaders(
      { accessToken: JWT, refreshToken: null },
      true,
      GATEWAY,
      "glm-5.2",
      {}
    );

    expect(headers["x-api-key"]).toBe(JWT);
    expect(headers["Authorization"]).toBe(`Bearer ${JWT}`);
    expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(headers["Anthropic-Version"]).toBe("2023-06-01");
  });

  it("resolves the gateway URL and the start-plan model list", () => {
    const executor = new DefaultExecutor("glm-start");
    expect(executor.buildUrl("glm-5.2", true)).toBe(GATEWAY);
    expect(getModelsByProviderId("glm-start").map((m) => m.id)).toEqual([
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.2",
      "glm-5-turbo",
    ]);
    expect(resolveProviderAlias("glm-start")).toBe("glm-start");
  });
});

describe("glm-start body injection (gateway content inspection)", () => {
  const executor = new DefaultExecutor("glm-start");
  const CLI_PREFIX = "You are ZCode, an interactive coding agent";

  it("prepends the ZCode identity blocks and keeps client system blocks", () => {
    const body = {
      model: "glm-5.2",
      system: [{ type: "text", text: "client rules" }],
      messages: [{ role: "user", content: "hi" }],
    };
    const out = executor.transformRequest("glm-5.2", body, true, {});

    expect(out.system).toHaveLength(3);
    expect(out.system[0]).toEqual({
      type: "text",
      text: CLI_PREFIX,
      cache_control: { type: "ephemeral" },
    });
    expect(out.system[1].text).toMatch(/^\nYou are an interactive ZCode agent .*# Harness/s);
    expect(out.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(out.system[2]).toEqual({ type: "text", text: "client rules" });
    expect(out.messages).toEqual(body.messages);
  });

  it("is idempotent across retry attempts and maps a string system", () => {
    const once = executor.transformRequest("glm-5.2", { system: "be terse", messages: [] }, true, {});
    const twice = executor.transformRequest("glm-5.2", once, true, {});

    expect(twice.system).toHaveLength(3);
    expect(twice.system[0].text).toBe(CLI_PREFIX);
    expect(twice.system[2]).toEqual({ type: "text", text: "be terse" });
  });

  it("binds the account through metadata.user_id", () => {
    const out = executor.transformRequest(
      "glm-5.2",
      { messages: [] },
      true,
      { providerSpecificData: { userId: "u-1" } }
    );
    expect(out.metadata).toEqual({ user_id: "u-1" });
  });

  it("leaves the paid glm provider untouched", () => {
    const body = { system: "keep me", messages: [] };
    expect(new DefaultExecutor("glm").transformRequest("glm-5.3", body, true, {})).toEqual(body);
  });
});

describe("glm-start login (no coding-plan key minting)", () => {
  let calls;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        return jsonResponse({
          code: 0,
          data: {
            status: "ready",
            token: JWT,
            user: { user_id: "u-1", name: "Trial User", email: "trial@example.com" },
            zai: { access_token: "zai-oauth-token" },
          },
        });
      })
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("stops at the poll response — no business/api_keys calls", async () => {
    const result = await glmStartProvider.pollToken(
      glmStartProvider.config,
      "flow-123",
      null,
      { _zcodePollToken: "t" }
    );

    expect(result.ok).toBe(true);
    expect(result.data.access_token).toBe(JWT);
    expect(calls).toHaveLength(1);

    const tokens = glmStartProvider.mapTokens(result.data);
    expect(tokens.accessToken).toBe(JWT);
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.providerSpecificData.zcodeJwtToken).toBe(JWT);
  });

  it("fails cleanly when the poll payload has no plan token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: 0, data: { status: "ready", user: {} } }))
    );

    const result = await glmStartProvider.pollToken(
      glmStartProvider.config,
      "flow-123",
      null,
      { _zcodePollToken: "t" }
    );
    expect(result.data.error).toBe("access_denied");
  });
});