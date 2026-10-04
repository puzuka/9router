import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

const WINDOW = { period: "24h", tzOffsetMinutes: 0 };
const NOW = new Date("2026-09-25T12:00:00.000Z");

function timestamp(offsetMinutes = 0) {
  return new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();
}

async function saveUsage(overrides = {}) {
  await db.saveRequestUsage({
    provider: "openai",
    model: "gpt-4o-mini",
    endpoint: "/v1/chat/completions",
    status: "ok",
    tokens: { prompt_tokens: 10, completion_tokens: 2 },
    timestamp: timestamp(),
    ...overrides,
  });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-quota-combo-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

beforeEach(async () => {
  const adapter = await import("@/lib/db/driver.js").then((module) => module.getAdapter());
  adapter.run("DELETE FROM quotaRules");
  adapter.run("DELETE FROM combos");
  adapter.run("DELETE FROM usageHistory");
  adapter.run("DELETE FROM usageDaily");
});

describe("quota logical model and combo attribution", () => {
  it("exposes selectable combos in quota targets", async () => {
    await db.createCombo({
      name: "space-bunny",
      kind: "llm",
      models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-5"],
    });

    const targets = await db.getQuotaTargets();
    expect(targets.combos).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "space-bunny",
        name: "space-bunny",
        kind: "llm",
        models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-5"],
      }),
    ]));
  });

  it("persists combo filters without changing legacy model filters", async () => {
    const rule = await db.createQuotaRule({
      scopeType: "global",
      scopeId: "global",
      period: "24h",
      metric: "requests",
      limitValue: 10,
      models: {
        mode: "include",
        include: ["gpt-4o", "gpt-4o"],
        exclude: [],
        includeCombos: ["space-bunny", "space-bunny"],
        excludeCombos: [],
      },
      enabled: true,
      description: "Combo-aware rule",
    });

    expect(rule.models).toEqual({
      mode: "include",
      include: ["gpt-4o"],
      exclude: [],
      includeCombos: ["space-bunny"],
      excludeCombos: [],
    });
  });

  it("matches only requests invoked through a selected combo", async () => {
    const rule = await db.createQuotaRule({
      scopeType: "global",
      scopeId: "global",
      period: "24h",
      metric: "requests",
      limitValue: 10,
      models: { mode: "include", include: [], includeCombos: ["space-bunny"] },
      enabled: true,
    });

    await saveUsage({ model: "gpt-4o-mini", comboName: "space-bunny", quotaRequestId: "combo-1" });

    expect((await db.checkQuota({ model: "gpt-4o-mini" })).allowed).toBe(true);
    expect((await db.checkQuota({ model: "gpt-4o-mini", comboName: "space-bunny", quotaRequestId: "combo-2" })).allowed).toBe(true);
    expect((await db.getQuotaUsage(rule, WINDOW)).requests).toBe(1);
  });

  it("keeps identical fusion legs as separate usage rows", async () => {
    const leg = {
      model: "gpt-4o-mini",
      comboName: "space-bunny",
      quotaRequestId: "fusion-identical",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
    };

    await saveUsage(leg);
    await saveUsage(leg);

    const usage = await db.getUsageHistory({ model: "gpt-4o-mini" });
    expect(usage).toHaveLength(2);
  });

  it("counts fusion legs as one logical request while summing actual usage", async () => {
    const rule = await db.createQuotaRule({
      scopeType: "global",
      scopeId: "global",
      period: "24h",
      metric: "totalTokens",
      limitValue: 100,
      models: { mode: "include", includeCombos: ["space-bunny"] },
      enabled: true,
    });

    await saveUsage({
      model: "gpt-4o-mini",
      requestedModel: "space-bunny",
      comboName: "space-bunny",
      quotaRequestId: "fusion-1",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      cost: 0.1,
    });
    await saveUsage({
      model: "claude-sonnet-4-5",
      requestedModel: "space-bunny",
      comboName: "space-bunny",
      quotaRequestId: "fusion-1",
      tokens: { prompt_tokens: 20, completion_tokens: 7 },
      cost: 0.2,
    });

    const usage = await db.getQuotaUsage(rule, WINDOW);
    expect(usage.requests).toBe(1);
    expect(usage.promptTokens).toBe(30);
    expect(usage.completionTokens).toBe(12);
    expect(usage.totalTokens).toBe(42);
    expect(usage.cost).toBeCloseTo(0.3, 8);
    expect(usage.used).toBe(42);
  });

  it("keeps model rules backward compatible", async () => {
    const rule = await db.createQuotaRule({
      scopeType: "global",
      scopeId: "global",
      period: "24h",
      metric: "requests",
      limitValue: 10,
      models: { mode: "include", include: ["gpt-4o-mini"] },
      enabled: true,
    });

    await saveUsage({ model: "gpt-4o-mini", comboName: "space-bunny", quotaRequestId: "combo-direct-member" });

    expect((await db.getQuotaUsage(rule, WINDOW)).requests).toBe(1);
    expect((await db.checkQuota({ model: "gpt-4o-mini", comboName: "space-bunny", quotaRequestId: "combo-direct-member" })).allowed).toBe(true);
  });

  it("does not exclude current fusion legs from token and cost limits", async () => {
    const tokenRule = await db.createQuotaRule({
      scopeType: "global",
      scopeId: "global",
      period: "24h",
      metric: "totalTokens",
      limitValue: 15,
      models: { mode: "include", includeCombos: ["space-bunny"] },
      enabled: true,
    });
    await saveUsage({
      comboName: "space-bunny",
      quotaRequestId: "fusion-1",
      tokens: { prompt_tokens: 10, completion_tokens: 10 },
    });

    const tokenCheck = await db.checkQuota({
      model: "gpt-4o-mini",
      comboName: "space-bunny",
      quotaRequestId: "fusion-1",
    });
    expect(tokenCheck.allowed).toBe(false);
    expect(tokenCheck.violation.rule.id).toBe(tokenRule.id);
    expect(tokenCheck.violation.used).toBe(20);

    await db.updateQuotaRule(tokenRule.id, { enabled: false });
    const costRule = await db.createQuotaRule({
      scopeType: "global",
      scopeId: "global",
      period: "24h",
      metric: "cost",
      limitValue: 0.05,
      models: { mode: "include", includeCombos: ["cost-bunny"] },
      enabled: true,
    });
    await saveUsage({
      comboName: "cost-bunny",
      quotaRequestId: "cost-fusion-1",
      cost: 0.1,
    });
    const costCheck = await db.checkQuota({
      model: "gpt-4o-mini",
      comboName: "cost-bunny",
      quotaRequestId: "cost-fusion-1",
    });
    expect(costCheck.allowed).toBe(false);
    expect(costCheck.violation.rule.id).toBe(costRule.id);
    expect(costCheck.violation.used).toBeCloseTo(0.1, 8);
  });

  it("excludes the in-flight request from its own request-count preflight", async () => {
    const rule = await db.createQuotaRule({
      scopeType: "global",
      scopeId: "global",
      period: "24h",
      metric: "requests",
      limitValue: 1,
      models: { mode: "include", includeCombos: ["space-bunny"] },
      enabled: true,
    });

    await saveUsage({ comboName: "space-bunny", quotaRequestId: "fusion-1", tokens: { prompt_tokens: 10, completion_tokens: 1 } });
    await saveUsage({ comboName: "space-bunny", quotaRequestId: "fusion-1", tokens: { prompt_tokens: 20, completion_tokens: 2 } });
    await saveUsage({ comboName: "space-bunny", quotaRequestId: "previous", tokens: { prompt_tokens: 1, completion_tokens: 1 } });

    const check = await db.checkQuota({
      model: "gpt-4o-mini",
      comboName: "space-bunny",
      quotaRequestId: "fusion-1",
    });
    expect(check.allowed).toBe(false);
    expect(check.violation.used).toBe(1);
  });
});
