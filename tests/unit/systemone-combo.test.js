import { describe, it, expect, vi, beforeEach } from "vitest";

// Handler-level combo tests: auth/quota/db are mocked, the pure node helpers in
// systemOneCore stay real so member routing (id/prefix) is exercised for real.
vi.mock("../../open-sse/handlers/systemOneCore.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, handleSystemOneCore: vi.fn() };
});
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderNodes: vi.fn(),
  getCombos: vi.fn(),
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/quota.js", () => ({
  createQuotaContext: (requestedModel, fields = {}, comboName = "") => ({
    ...fields,
    requestedModel,
    comboName: comboName || null,
    quotaRequestId: fields.quotaRequestId || `quota-${requestedModel}`,
  }),
  enforceQuota: vi.fn(),
  recordSuccessfulUsage: vi.fn(),
  shouldFallbackForQuota: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  request: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  maskKey: vi.fn((k) => k),
}));

import { handleSystemOne } from "../../src/sse/handlers/systemOne.js";
import { handleSystemOneCore } from "../../open-sse/handlers/systemOneCore.js";
import { getComboModelsFromData } from "../../open-sse/services/combo.js";
import { getSettings, getProviderNodes, getCombos } from "@/lib/localDb";
import {
  extractApiKey,
  isValidApiKey,
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
} from "@/sse/services/auth.js";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh.js";
import { enforceQuota, recordSuccessfulUsage } from "@/sse/services/quota.js";

const NODE = {
  id: "systemone-compatible-n1",
  prefix: "so-prod",
  name: "My Gateway",
  baseUrl: "https://gw.example.com/v1",
};

const COMBO = { id: "c1", name: "so-combo", models: ["typesafe-ai", "so-prod"], kind: "systemOne" };

const VALID_BODY = {
  state: { task: "Review a proposed change" },
  questions: {
    review: {
      type: "choice",
      instructions: "Accept or review?",
      criteria: { accept: "Evidence supports it.", review: "Evidence is missing." },
    },
  },
};

function makeRequest(model) {
  return new Request("http://localhost:20128/api/v1/systemone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, ...VALID_BODY }),
  });
}

function coreResult({ provider, body }, outcome) {
  if (outcome === "fail") {
    return {
      success: false,
      status: 429,
      error: "rate limit",
      response: new Response(JSON.stringify({ error: { message: "rate limit" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  return {
    success: true,
    data: { provider: provider.id, model: body.model, answers: { review: { choice: "accept" } } },
    response: new Response(JSON.stringify({ provider: provider.id, model: body.model }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  extractApiKey.mockReturnValue(null);
  isValidApiKey.mockResolvedValue(true);
  getSettings.mockResolvedValue({ requireApiKey: false, comboStrategies: {}, comboStrategy: "fallback" });
  getCombos.mockResolvedValue([COMBO]);
  getProviderNodes.mockResolvedValue([NODE]);
  getProviderCredentials.mockImplementation((providerId, excludeConnectionIds) => {
    const connectionId = `conn-${providerId}`;
    if (excludeConnectionIds?.has(connectionId)) return Promise.resolve(null);
    return Promise.resolve({ connectionId, connectionName: connectionId, apiKey: `key-${providerId}` });
  });
  markAccountUnavailable.mockResolvedValue({ shouldFallback: true });
  clearAccountError.mockResolvedValue(undefined);
  checkAndRefreshToken.mockImplementation((_providerId, credentials) => Promise.resolve(credentials));
  enforceQuota.mockResolvedValue({ allowed: true });
  recordSuccessfulUsage.mockResolvedValue(undefined);
});

describe("handleSystemOne combo expansion", () => {
  it("expands a combo name and falls through to the next member on failure", async () => {
    handleSystemOneCore.mockImplementation((args) =>
      coreResult(args, args.provider.id === "typesafe-ai" ? "fail" : "ok")
    );

    const response = await handleSystemOne(makeRequest("so-combo"));

    expect(handleSystemOneCore).toHaveBeenCalledTimes(2);

    const first = handleSystemOneCore.mock.calls[0][0];
    expect(first.provider.id).toBe("typesafe-ai");
    expect(first.body.model).toBe("jev-latest"); // combo name replaced by member default model
    expect(first.credentials.apiKey).toBe("key-typesafe-ai");

    const second = handleSystemOneCore.mock.calls[1][0];
    expect(second.provider.id).toBe("systemone-compatible-n1"); // node prefix resolved to node id
    expect(second.providerConfig.baseUrl).toBe("https://gw.example.com/v1/systemone");
    expect(second.credentials.apiKey).toBe("key-systemone-compatible-n1");

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.provider).toBe("systemone-compatible-n1");
    expect(data.model).toBe("jev-latest");
    expect(recordSuccessfulUsage).toHaveBeenCalledTimes(1);
    expect(recordSuccessfulUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "systemone-compatible-n1",
      model: "jev-latest",
      requestedModel: "so-combo",
      comboName: "so-combo",
      quotaRequestId: "quota-so-combo",
    }));
    expect(enforceQuota).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: "systemone-compatible-n1",
      model: "jev-latest",
      requestedModel: "so-combo",
      comboName: "so-combo",
      quotaRequestId: "quota-so-combo",
    }));
  });

  it("keeps a member's explicit provider/model suffix", async () => {
    handleSystemOneCore.mockImplementation((args) => coreResult(args, "ok"));
    getCombos.mockResolvedValue([
      { id: "c2", name: "so-explicit", models: ["typesafe-ai/jev-latest"], kind: "systemOne" },
    ]);

    const response = await handleSystemOne(makeRequest("so-explicit"));

    expect(response.status).toBe(200);
    expect(handleSystemOneCore).toHaveBeenCalledTimes(1);
    const call = handleSystemOneCore.mock.calls[0][0];
    expect(call.provider.id).toBe("typesafe-ai");
    expect(call.body.model).toBe("jev-latest");
  });

  it("does not treat a plain provider name as a combo", async () => {
    handleSystemOneCore.mockImplementation((args) => coreResult(args, "ok"));

    const response = await handleSystemOne(makeRequest("typesafe-ai"));

    expect(response.status).toBe(200);
    expect(handleSystemOneCore).toHaveBeenCalledTimes(1);
    expect(handleSystemOneCore.mock.calls[0][0].provider.id).toBe("typesafe-ai");
  });
});

describe("getComboModelsFromData systemOne guardrails", () => {
  it("expands a combo name but not a provider/model string", () => {
    expect(getComboModelsFromData("so-combo", [COMBO])).toEqual(["typesafe-ai", "so-prod"]);
    expect(getComboModelsFromData("typesafe-ai/jev-latest", [COMBO])).toBeNull();
    expect(getComboModelsFromData("unknown", [COMBO])).toBeNull();
  });
});
