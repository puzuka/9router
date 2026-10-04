import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveRequestUsage: vi.fn(),
  checkQuota: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: mocks.saveRequestUsage }));
vi.mock("@/lib/localDb", () => ({ checkQuota: mocks.checkQuota }));

import { createQuotaContext, recordSuccessfulUsage } from "@/sse/services/quota.js";
import { saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("quota attribution forwarding", () => {
  it("creates stable attribution fields for combo requests", () => {
    const context = createQuotaContext("space-bunny", { quotaRequestId: "logical-1" }, "space-bunny");
    expect(context).toEqual({
      quotaRequestId: "logical-1",
      requestedModel: "space-bunny",
      comboName: "space-bunny",
    });
  });

  it("keeps actual model when media usage records combo attribution", async () => {
    mocks.saveRequestUsage.mockResolvedValue(undefined);

    await recordSuccessfulUsage({
      provider: "openai",
      model: "gpt-4o-mini",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
      requestedModel: "space-bunny",
      comboName: "space-bunny",
      quotaRequestId: "logical-1",
    });

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "gpt-4o-mini",
      requestedModel: "space-bunny",
      comboName: "space-bunny",
      quotaRequestId: "logical-1",
    }));
  });

  it("keeps actual model when chat usage records combo attribution", async () => {
    mocks.saveRequestUsage.mockResolvedValue(undefined);

    saveUsageStats({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      tokens: { prompt_tokens: 20, completion_tokens: 5 },
      silent: true,
      quotaContext: {
        requestedModel: "space-bunny",
        comboName: "space-bunny",
        quotaRequestId: "logical-1",
      },
    });

    expect(mocks.saveRequestUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      requestedModel: "space-bunny",
      comboName: "space-bunny",
      quotaRequestId: "logical-1",
    }));
  });
});
