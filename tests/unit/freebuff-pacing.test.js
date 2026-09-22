import { describe, expect, it, beforeEach } from "vitest";
import {
  acquireFreebuffRequestSlot,
  freebuffPacingRemainingMs,
  hashFreebuffToken,
  computeFreebuffWaitMs,
  getFreebuffPacingGapMs,
  applyFreebuffPacingSettings,
  getEffectiveFreebuffPacingGapSeconds,
} from "../../open-sse/shared/freebuffPacing.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

describe("freebuff pacing", () => {
  beforeEach(() => {
    // Fresh registry per test (module-level globalThis state).
    delete globalThis.__9routerFreebuffPacing__;
  });

  it("defaults to 20s gap", () => {
    expect(getFreebuffPacingGapMs()).toBe(20_000);
  });

  it("uses the dashboard setting when one is stored", () => {
    // `pacingGapSeconds: 10` in the dashboard must mean a 10,000ms gap, and it
    // outranks both the env var and the registry value.
    try {
      applyFreebuffPacingSettings({ providerStrategies: { freebuff: { pacingGapSeconds: 10 } } });
      expect(getFreebuffPacingGapMs()).toBe(10_000);
      expect(getEffectiveFreebuffPacingGapSeconds()).toBe(10);

      process.env.FREEBUFF_PACING_GAP_MS = "30000";
      applyFreebuffPacingSettings({ providerStrategies: { freebuff: { pacingGapSeconds: 5 } } });
      expect(getFreebuffPacingGapMs()).toBe(5_000);
    } finally {
      delete process.env.FREEBUFF_PACING_GAP_MS;
      applyFreebuffPacingSettings({});
    }
  });

  it("falls back to 20s when the dashboard setting is absent or cleared", () => {
    // The whole promise of the field: "not set" means the default, never a
    // leftover number.
    for (const settings of [
      {},
      { providerStrategies: {} },
      { providerStrategies: { freebuff: {} } },
      { providerStrategies: { freebuff: { strictModelAssignment: true } } },
      { providerStrategies: { freebuff: { pacingGapSeconds: "" } } },
      { providerStrategies: { freebuff: { pacingGapSeconds: null } } },
      { providerStrategies: { freebuff: { pacingGapSeconds: "abc" } } },
      { providerStrategies: { freebuff: { pacingGapSeconds: 0 } } },
      { providerStrategies: { freebuff: { pacingGapSeconds: -5 } } },
      undefined,
      null,
    ]) {
      applyFreebuffPacingSettings(settings);
      expect(getFreebuffPacingGapMs()).toBe(20_000);
    }
  });

  it("clears a stored override when the setting is removed", () => {
    applyFreebuffPacingSettings({ providerStrategies: { freebuff: { pacingGapSeconds: 7 } } });
    expect(getFreebuffPacingGapMs()).toBe(7_000);
    // User empties the field → back to the default, not stuck at 7s.
    applyFreebuffPacingSettings({ providerStrategies: { freebuff: {} } });
    expect(getFreebuffPacingGapMs()).toBe(20_000);
  });

  it("accepts a numeric string from a form field", () => {
    applyFreebuffPacingSettings({ providerStrategies: { freebuff: { pacingGapSeconds: "12" } } });
    expect(getFreebuffPacingGapMs()).toBe(12_000);
    applyFreebuffPacingSettings({});
  });

  it("paces by the dashboard setting end-to-end", () => {
    try {
      applyFreebuffPacingSettings({ providerStrategies: { freebuff: { pacingGapSeconds: 10 } } });
      expect(acquireFreebuffRequestSlot("token-dash", 1_000)).toBe(true);
      expect(acquireFreebuffRequestSlot("token-dash", 10_000)).toBe(false);
      expect(acquireFreebuffRequestSlot("token-dash", 12_000)).toBe(true);
    } finally {
      applyFreebuffPacingSettings({});
    }
  });

  it("reads the gap from the provider registry, in seconds", () => {
    // `pacing.gapSeconds: 10` must mean a 10,000ms gap — the whole point of
    // exposing it as config rather than a hardcoded constant.
    const original = PROVIDERS.freebuff.pacing;
    try {
      PROVIDERS.freebuff.pacing = { gapSeconds: 10 };
      expect(getFreebuffPacingGapMs()).toBe(10_000);
      PROVIDERS.freebuff.pacing = { gapSeconds: 45 };
      expect(getFreebuffPacingGapMs()).toBe(45_000);
    } finally {
      PROVIDERS.freebuff.pacing = original;
    }
  });

  it("lets the env var override the provider config", () => {
    const original = process.env.FREEBUFF_PACING_GAP_MS;
    const originalPacing = PROVIDERS.freebuff.pacing;
    try {
      PROVIDERS.freebuff.pacing = { gapSeconds: 10 };
      process.env.FREEBUFF_PACING_GAP_MS = "30000";
      expect(getFreebuffPacingGapMs()).toBe(30_000);
    } finally {
      if (original === undefined) delete process.env.FREEBUFF_PACING_GAP_MS;
      else process.env.FREEBUFF_PACING_GAP_MS = original;
      PROVIDERS.freebuff.pacing = originalPacing;
    }
  });

  it("falls back to the built-in default when config is missing or unusable", () => {
    const original = PROVIDERS.freebuff.pacing;
    try {
      PROVIDERS.freebuff.pacing = undefined;
      expect(getFreebuffPacingGapMs()).toBe(20_000);
      PROVIDERS.freebuff.pacing = { gapSeconds: "not-a-number" };
      expect(getFreebuffPacingGapMs()).toBe(20_000);
    } finally {
      PROVIDERS.freebuff.pacing = original;
    }
  });

  it("paces by the configured gap, not the default", () => {
    const original = PROVIDERS.freebuff.pacing;
    try {
      PROVIDERS.freebuff.pacing = { gapSeconds: 10 };
      expect(acquireFreebuffRequestSlot("token-cfg", 1_000)).toBe(true);
      // 9s < 10s gap → still blocked.
      expect(acquireFreebuffRequestSlot("token-cfg", 10_000)).toBe(false);
      // 11s > 10s gap → allowed.
      expect(acquireFreebuffRequestSlot("token-cfg", 12_000)).toBe(true);
    } finally {
      PROVIDERS.freebuff.pacing = original;
    }
  });

  it("allows the first request immediately", () => {
    expect(acquireFreebuffRequestSlot("token-a", 1_000)).toBe(true);
  });

  it("blocks a second request within the gap", () => {
    acquireFreebuffRequestSlot("token-a", 1_000);
    expect(acquireFreebuffRequestSlot("token-a", 1_000 + 10_000)).toBe(false);
    expect(freebuffPacingRemainingMs("token-a", 1_000 + 10_000)).toBeGreaterThan(0);
  });

  it("allows again after the gap elapsed", () => {
    acquireFreebuffRequestSlot("token-a", 1_000);
    // Default gap is 20s; jump past it.
    expect(acquireFreebuffRequestSlot("token-a", 1_000 + 25_000)).toBe(true);
  });

  it("tracks accounts independently", () => {
    acquireFreebuffRequestSlot("token-a", 1_000);
    expect(acquireFreebuffRequestSlot("token-b", 1_000)).toBe(true);
  });

  it("hashes tokens stably and never returns the raw token", () => {
    const h1 = hashFreebuffToken("secret-token-xyz");
    const h2 = hashFreebuffToken("secret-token-xyz");
    expect(h1).toBe(h2);
    expect(h1).not.toContain("secret");
    expect(hashFreebuffToken("")).toBe("");
  });
});

describe("computeFreebuffWaitMs", () => {
  it("returns 0 when no retryAfter", () => {
    expect(computeFreebuffWaitMs(null, 5_000)).toBe(0);
  });

  it("returns 0 when the lock is already expired", () => {
    expect(computeFreebuffWaitMs(1_000, 5_000)).toBe(0);
  });

  it("returns the remaining wait when within the max", () => {
    expect(computeFreebuffWaitMs(15_000, 5_000)).toBe(10_000);
  });

  it("accepts an ISO string (auth.js retryAfter format)", () => {
    // auth.js returns getEarliestModelLockUntil() → ISO string of a future lock
    const iso = new Date(15_000).toISOString();
    expect(computeFreebuffWaitMs(iso, 5_000)).toBe(10_000);
  });

  it("accepts a Date object", () => {
    expect(computeFreebuffWaitMs(new Date(15_000), 5_000)).toBe(10_000);
  });

  it("returns 0 for an already-expired ISO string", () => {
    expect(computeFreebuffWaitMs(new Date(1_000).toISOString(), 5_000)).toBe(0);
  });

  it("returns 0 when the wait would exceed the max (fail fast)", () => {
    // retryAfter 45s − now 5s = 40s wait, above the 30s max → fail fast.
    expect(computeFreebuffWaitMs(45_000, 5_000)).toBe(0);
  });
});