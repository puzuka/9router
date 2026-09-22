import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Freebuff's picker catalog is server-authoritative, so its windows/modal flags
// must come from the provider table rather than the generic pattern fallback —
// `*gpt-5*` reads 400K for Luna where freebuff budgets 1M, and `*o4*` used to
// claim vision for Solar Pro 4 (a bare Model-Name substring match on "solar-prO4").
describe("freebuff provider capabilities", () => {
  const caps = (model) => getCapabilitiesForModel("freebuff", model);

  it("budgets Luna at freebuff's 1M window, not the 400K gpt-5 pattern", () => {
    expect(caps("openai/gpt-5.6-luna")).toMatchObject({
      contextWindow: 1000000,
      maxOutput: 128000,
      vision: true,
      reasoning: true,
    });
  });

  it("marks DeepSeek V4.1 Flash multimodal (native vision since 2026-09-10)", () => {
    expect(caps("deepseek/deepseek-v4-flash")).toMatchObject({
      contextWindow: 1048576,
      maxOutput: 384000,
      vision: true,
    });
  });

  it("treats Solar Pro 4 as text-only with freebuff's 500K window", () => {
    expect(caps("upstage/solar-pro4")).toMatchObject({
      contextWindow: 500000,
      vision: false,
    });
  });

  it("treats Muse Spark 1.2 as text-only with freebuff's 1M window", () => {
    expect(caps("meta/muse-spark-1.2-contributor")).toMatchObject({
      contextWindow: 1000000,
      vision: false,
    });
  });

  it("keeps GLM 5.3 Flash on the zai thinking format at 1M", () => {
    expect(caps("z-ai/glm-5.3-flash")).toMatchObject({
      contextWindow: 1000000,
      thinkingFormat: "zai",
      vision: true,
    });
  });

  it("does not leak the freebuff table onto the same model on another provider", () => {
    // Only freebuff declares Luna's 1M budget; a gateway with no Luna row of
    // its own keeps the generic pattern resolution (400K), so the provider key
    // must not shadow the global model entry. (This repo has no Nous provider,
    // where the upstream fork asserted 1050000 from Nous's own table.)
    expect(getCapabilitiesForModel("openrouter", "openai/gpt-5.6-luna").contextWindow).toBe(400000);
  });
});
