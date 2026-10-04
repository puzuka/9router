import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(),
}));

describe("buildQuotaModelTargets", () => {
  it("builds model targets from supported, pricing, alias, and custom model sources", { timeout: 15000 }, async () => {
    const { buildQuotaModelTargets } = await import("@/lib/db/repos/quotaRepo.js");
    const targets = buildQuotaModelTargets({
      supportedModels: [
        { provider: "openai", model: "gpt-4o", name: "GPT-4o" },
        { provider: "anthropic", model: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      ],
      pricing: {
        openrouter: {
          "deepseek/deepseek-chat": { input: 1, output: 1 },
        },
      },
      aliases: {
        fast: "openai/gpt-4o-mini",
        objectAlias: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
      customModels: [
        { providerAlias: "openai-compatible", id: "glm-4.7", name: "GLM 4.7" },
      ],
    });
    const models = new Map(targets.map((model) => [model.id, model]));

    expect(models.get("gpt-4o")).toMatchObject({ name: "GPT-4o", providers: ["openai"] });
    expect(models.get("deepseek/deepseek-chat")).toMatchObject({ providers: ["openrouter"] });
    expect(models.get("gpt-4o-mini")).toMatchObject({ name: "fast", providers: ["openai"] });
    expect(models.get("claude-haiku-4-5")).toMatchObject({ name: "objectAlias", providers: ["anthropic"] });
    expect(models.get("glm-4.7")).toMatchObject({ name: "GLM 4.7", providers: ["openai-compatible"] });
  });
});
