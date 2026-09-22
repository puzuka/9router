import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseQuotaData,
  formatFreebucksPrice,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

// Locks the Freebucks price path from the usage handler's payload down to the
// row QuotaTable renders.
//
// Why this test exists: parseQuotaData's switch once contained TWO
// `case "freebuff":` arms. A switch takes the first matching arm, so the later
// arm — the one carrying price/priceNote/peak — was dead code, and every priced
// row silently lost its price. Duplicate arms are invisible in review but fatal
// at runtime, so the assertion below is not just "a price exists": it requires
// the count of priced rows to equal the count of priced models in the payload.
//
// The fixture is a real session payload (server-authoritative prices) captured
// from the freebuff session endpoint, with the credential stripped. No network.
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "freebuff-session-priced.json");

describe("freebuff Freebucks prices survive parseQuotaData", () => {
  const payload = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

  it("keeps a price on every model the server priced", () => {
    const rows = parseQuotaData("freebuff", payload);
    const priced = Object.values(payload.quotas).filter((q) => q.price !== undefined);

    expect(priced.length).toBeGreaterThan(0);
    expect(rows.length).toBe(Object.keys(payload.quotas).length);
    expect(rows.filter((r) => r.price !== undefined).length).toBe(priced.length);
  });

  it("renders each price as a Freebucks/hr rate", () => {
    for (const row of parseQuotaData("freebuff", payload)) {
      expect(row.price).toBeTypeOf("number");
      expect(formatFreebucksPrice(row.price)).toMatch(/^\d+ Freebucks\/hr$/);
    }
  });

  it("carries the promo tagline and the recurring flag", () => {
    const rows = parseQuotaData("freebuff", payload);
    const free = rows.find((r) => r.priceNote);
    // Solar Pro 4 is the promo row: 0 Freebucks with its own tagline.
    expect(free.price).toBe(0);
    expect(free.priceNote).toBeTypeOf("string");
    expect(free.recurring).toBe(true);
  });

  it("meters every row against the shared daily pool", () => {
    // The captured account happened to sit at 0 spent, which would make a
    // "row.used === pool.spent" assertion pass even if used were hardcoded to 0.
    // Shift the pool in memory so value propagation is actually exercised.
    const shifted = structuredClone(payload);
    shifted.freebucks.daily = { ...shifted.freebucks.daily, spent: 7, remaining: 93 };
    for (const q of Object.values(shifted.quotas)) q.used = 7;

    const rows = parseQuotaData("freebuff", shifted);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.used).toBe(7);
      expect(row.total).toBe(shifted.freebucks.daily.limit);
    }
  });

  it("has exactly one freebuff arm in the parser switch", () => {
    // The regression guard: a second arm silently shadows the first.
    const src = fs.readFileSync(
      path.join(here, "..", "..", "src", "app", "(dashboard)", "dashboard", "usage",
                "components", "ProviderLimits", "utils.js"),
      "utf8",
    );
    const start = src.indexOf("export function parseQuotaData");
    const body = src.slice(start, src.indexOf("\n  return normalizedQuotas;\n}", start));
    const arms = [...body.matchAll(/case "freebuff":/g)];
    expect(arms.length).toBe(1);
  });
});
