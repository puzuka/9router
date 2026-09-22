import { describe, it, expect, vi, afterEach } from "vitest";

import {
  validateSystemOneBody,
  buildSystemOnePayload,
  handleSystemOneCore,
  systemOneNodeEndpoint,
  findSystemOneNode,
  buildSystemOneNodeProvider,
} from "../../open-sse/handlers/systemOneCore.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  MEDIA_PROVIDER_KINDS,
  resolveProviderId,
  getProvidersByKind,
  AI_PROVIDERS,
  isSystemOneCompatibleProvider,
  SYSTEMONE_COMPATIBLE_PREFIX,
} from "../../src/shared/constants/providers.js";

const VALID_BODY = {
  model: "jev-latest",
  state: { task: "Review a proposed change" },
  questions: {
    review: {
      type: "choice",
      instructions: "Accept or review?",
      criteria: { accept: "Evidence supports it.", review: "Evidence is missing." },
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("systemone registry wiring", () => {
  it("registers both System One providers with the upstream endpoint", () => {
    const typesafe = REGISTRY.find((r) => r.id === "typesafe-ai");
    const xpl = REGISTRY.find((r) => r.id === "experiential-labs");

    expect(typesafe).toBeTruthy();
    expect(xpl).toBeTruthy();
    expect(typesafe.serviceKinds).toContain("systemOne");
    expect(xpl.serviceKinds).toContain("systemOne");
    expect(typesafe.systemOneConfig.baseUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(xpl.systemOneConfig.baseUrl).toBe("https://api.experientiallabs.ai/v1/systemone");
  });

  it("registers the jev-latest model on both providers", () => {
    for (const id of ["typesafe-ai", "experiential-labs"]) {
      const entry = REGISTRY.find((r) => r.id === id);
      expect(entry.models.map((m) => m.id)).toContain("jev-latest");
      expect(entry.models.find((m) => m.id === "jev-latest").kind).toBe("systemOne");
    }
  });

  it("exposes the systemOne media kind at POST /v1/systemone", () => {
    const kind = MEDIA_PROVIDER_KINDS.find((k) => k.id === "systemOne");
    expect(kind).toBeTruthy();
    expect(kind.label).toBe("System One");
    expect(kind.endpoint).toEqual({ method: "POST", path: "/v1/systemone" });
  });

  it("resolves every alias spelling to the right provider id", () => {
    expect(resolveProviderId("typesafe")).toBe("typesafe-ai");
    expect(resolveProviderId("typesafe-ai")).toBe("typesafe-ai");
    expect(resolveProviderId("xpl")).toBe("experiential-labs");
    expect(resolveProviderId("experiential-labs")).toBe("experiential-labs");
  });

  it("lists both providers under the systemOne kind", () => {
    const ids = getProvidersByKind("systemOne").map((p) => p.id);
    expect(ids).toContain("typesafe-ai");
    expect(ids).toContain("experiential-labs");
    expect(AI_PROVIDERS["typesafe-ai"].systemOneConfig.defaultModel).toBe("jev-latest");
  });
});

describe("validateSystemOneBody", () => {
  it("accepts a well-formed body", () => {
    expect(validateSystemOneBody(VALID_BODY)).toBeNull();
  });

  it("rejects missing or non-object state / questions", () => {
    expect(validateSystemOneBody({ ...VALID_BODY, state: undefined })).toMatch(/state/);
    expect(validateSystemOneBody({ ...VALID_BODY, state: "text" })).toMatch(/state/);
    expect(validateSystemOneBody({ ...VALID_BODY, questions: null })).toMatch(/questions/);
    expect(validateSystemOneBody({ ...VALID_BODY, questions: [1] })).toMatch(/questions/);
  });

  it("rejects empty questions and malformed question entries", () => {
    expect(validateSystemOneBody({ ...VALID_BODY, questions: {} })).toMatch(/must not be empty/);
    const noType = { ...VALID_BODY, questions: { q: { criteria: { a: "x" } } } };
    expect(validateSystemOneBody(noType)).toMatch(/questions\.q\.type/);
    const noCriteria = { ...VALID_BODY, questions: { q: { type: "choice" } } };
    expect(validateSystemOneBody(noCriteria)).toMatch(/questions\.q\.criteria/);
  });
});

describe("buildSystemOnePayload", () => {
  it("defaults the model from provider config", () => {
    const { model } = buildSystemOnePayload({ body: { state: {}, questions: {} }, defaultModel: "jev-latest" });
    expect(model).toBe("jev-latest");
  });

  it("keeps an explicit model and strips the routing key", () => {
    const payload = buildSystemOnePayload({
      body: { ...VALID_BODY, provider: "typesafe-ai" },
      defaultModel: "jev-latest",
    });
    expect(payload.model).toBe("jev-latest");
    expect(payload.provider).toBeUndefined();
  });

  it("forwards unknown extra fields to the upstream payload", () => {
    const payload = buildSystemOnePayload({
      body: { ...VALID_BODY, metadata: { run: "ci" } },
      defaultModel: "jev-latest",
    });
    expect(payload.metadata).toEqual({ run: "ci" });
  });
});

describe("systemone-compatible custom nodes", () => {
  it("detects the systemone-compatible id prefix", () => {
    expect(isSystemOneCompatibleProvider(`${SYSTEMONE_COMPATIBLE_PREFIX}abc123`)).toBe(true);
    expect(isSystemOneCompatibleProvider("openai-compatible-chat-abc")).toBe(false);
    expect(isSystemOneCompatibleProvider("typesafe-ai")).toBe(false);
    expect(isSystemOneCompatibleProvider(undefined)).toBe(false);
  });

  it("joins a node base URL with /systemone without doubling the suffix", () => {
    expect(systemOneNodeEndpoint("https://gw.example.com/v1")).toBe("https://gw.example.com/v1/systemone");
    expect(systemOneNodeEndpoint("https://gw.example.com/v1/")).toBe("https://gw.example.com/v1/systemone");
    expect(systemOneNodeEndpoint("https://gw.example.com/v1/systemone")).toBe("https://gw.example.com/v1/systemone");
    expect(systemOneNodeEndpoint("https://gw.example.com/v1/systemone/")).toBe("https://gw.example.com/v1/systemone");
  });

  it("finds nodes by id or prefix", () => {
    const nodes = [
      { id: `${SYSTEMONE_COMPATIBLE_PREFIX}a`, prefix: "so-prod", baseUrl: "https://a.example.com/v1" },
      { id: `${SYSTEMONE_COMPATIBLE_PREFIX}b`, prefix: "so-backup", baseUrl: "https://b.example.com/v1/systemone" },
    ];
    expect(findSystemOneNode(nodes, `${SYSTEMONE_COMPATIBLE_PREFIX}b`).prefix).toBe("so-backup");
    expect(findSystemOneNode(nodes, "so-prod").id).toBe(`${SYSTEMONE_COMPATIBLE_PREFIX}a`);
    expect(findSystemOneNode(nodes, "missing")).toBeNull();
    expect(findSystemOneNode(nodes, undefined)).toBeNull();
  });

  it("builds a synthetic provider + config pointing at the node endpoint", () => {
    const node = { id: `${SYSTEMONE_COMPATIBLE_PREFIX}x`, prefix: "so-prod", name: "My Gateway", baseUrl: "https://gw.example.com/v1/" };
    const { provider, providerConfig } = buildSystemOneNodeProvider(node);
    expect(provider.id).toBe(`${SYSTEMONE_COMPATIBLE_PREFIX}x`);
    expect(providerConfig.baseUrl).toBe("https://gw.example.com/v1/systemone");
    expect(providerConfig.defaultModel).toBe("jev-latest");
    expect(providerConfig.authType).toBe("apikey");
  });
});

describe("handleSystemOneCore", () => {
  const provider = REGISTRY.find((r) => r.id === "typesafe-ai");
  const providerConfig = provider.systemOneConfig;
  const credentials = { apiKey: "apikey_test", connectionName: "test" };

  const upstreamResponse = {
    model: "jev-1.13.0",
    answers: { review: { type: "choice", choice: "review", confidence: 0.97 } },
    usage: { input_tokens: 416, output_tokens: 31 },
  };

  it("posts the payload with bearer auth and passes the answer envelope through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(upstreamResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleSystemOneCore({
      body: { ...VALID_BODY, provider: "typesafe-ai", model: undefined },
      provider,
      providerConfig,
      credentials,
      log: console,
    });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer apikey_test");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("jev-latest");
    expect(sent.provider).toBeUndefined();
    expect(sent.questions.review.type).toBe("choice");

    expect(result.data.provider).toBe("typesafe-ai");
    expect(result.data.answers.review.choice).toBe("review");
    expect(result.data.usage).toEqual({ input_tokens: 416, output_tokens: 31 });

    const body = await result.response.json();
    expect(body.answers.review.choice).toBe("review");
  });

  it("router provider tag wins over a same-named upstream field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...upstreamResponse, provider: "typesafe" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleSystemOneCore({
      body: VALID_BODY, provider, providerConfig, credentials, log: console,
    });

    expect(result.success).toBe(true);
    expect(result.data.provider).toBe("typesafe-ai");
  });

  it("maps an upstream auth failure to a non-success result with the same status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "bad key" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleSystemOneCore({
      body: VALID_BODY, provider, providerConfig, credentials, log: console,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/401/);
  });

  it("returns 400 for a structurally invalid body without calling upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleSystemOneCore({
      body: { state: {}, questions: {} }, provider, providerConfig, credentials, log: console,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails with 401 when no credentials are available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleSystemOneCore({
      body: VALID_BODY, provider, providerConfig, credentials: null, log: console,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
