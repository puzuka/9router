import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-provider-usage-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("provider usage breakdown", () => {
  it("aggregates per provider and per account with period filtering", async () => {
    const openaiConn = await db.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI Prod",
      email: "ops@example.com",
      apiKey: "sk-openai",
    });
    const anthropicConn = await db.createProviderConnection({
      provider: "anthropic",
      authType: "oauth",
      name: "Claude Workspace",
      email: "team@example.com",
    });

    const now = new Date();
    const withinWindow = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const olderThan30d = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();

    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      connectionId: openaiConn.id,
      status: "ok",
      cost: 0.12,
      tokens: { prompt_tokens: 120, completion_tokens: 80 },
      timestamp: withinWindow,
    });
    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4o",
      connectionId: openaiConn.id,
      status: "FAILED 429",
      cost: 0.03,
      tokens: { prompt_tokens: 30, completion_tokens: 10 },
      timestamp: withinWindow,
    });
    await db.saveRequestUsage({
      provider: "anthropic",
      model: "claude-3.7-sonnet",
      connectionId: anthropicConn.id,
      status: "ok",
      cost: 0.2,
      tokens: { prompt_tokens: 200, completion_tokens: 50 },
      timestamp: olderThan30d,
    });

    const breakdown30d = await db.getProviderUsageBreakdown({ period: "30d", tzOffsetMinutes: 0 });
    expect(breakdown30d.totals.totalProviders).toBe(1);
    expect(breakdown30d.totals.totalRequests).toBe(2);
    expect(breakdown30d.providers).toHaveLength(1);
    expect(breakdown30d.providers[0].id).toBe("openai");
    expect(breakdown30d.providers[0].requests).toBe(2);
    expect(breakdown30d.providers[0].promptTokens).toBe(150);
    expect(breakdown30d.providers[0].completionTokens).toBe(90);
    expect(breakdown30d.providers[0].totalTokens).toBe(240);
    expect(breakdown30d.providers[0].cost).toBeCloseTo(0.15, 6);
    expect(breakdown30d.providers[0].accounts).toHaveLength(1);
    expect(breakdown30d.providers[0].accounts[0].label).toBe("OpenAI Prod");
    expect(breakdown30d.providers[0].accounts[0].statusCounts.ok).toBe(1);
    expect(breakdown30d.providers[0].accounts[0].statusCounts["FAILED 429"]).toBe(1);

    const breakdownAll = await db.getProviderUsageBreakdown({ period: "all", tzOffsetMinutes: 0 });
    expect(breakdownAll.totals.totalProviders).toBe(2);
    expect(breakdownAll.totals.totalRequests).toBe(3);
    expect(breakdownAll.providers.map((provider) => provider.id)).toEqual(["openai", "anthropic"]);
    expect(breakdownAll.providers[1].accounts[0].label).toBe("Claude Workspace");
    expect(breakdownAll.providers[1].accounts[0].secondary).toContain("team@example.com");

    const openaiOnly = await db.getProviderUsageBreakdown({ period: "all", provider: "openai", tzOffsetMinutes: 0 });
    expect(openaiOnly.totals.totalProviders).toBe(1);
    expect(openaiOnly.totals.totalRequests).toBe(2);
    expect(openaiOnly.providers).toHaveLength(1);
    expect(openaiOnly.providers[0].id).toBe("openai");
  });
});
