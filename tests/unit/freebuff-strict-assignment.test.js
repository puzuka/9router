import { describe, it, expect } from "vitest";
import { filterConnectionsForModel } from "@/sse/services/auth.js";

const conns = [
  { id: "a", providerSpecificData: { assignedModel: "mimo/mimo-v2.5" } },
  { id: "b", providerSpecificData: { assignedModel: "openai/gpt-5.6-luna" } },
  { id: "c", providerSpecificData: {} },
  { id: "d" },
];

describe("filterConnectionsForModel (freebuff strict assignment)", () => {
  it("returns all connections when strict is off", () => {
    const settings = { providerStrategies: { freebuff: {} } };
    expect(filterConnectionsForModel("freebuff", conns, "mimo/mimo-v2.5", settings)).toEqual(conns);
  });

  it("returns all connections for non-freebuff providers even with flag on", () => {
    const settings = { providerStrategies: { freebuff: { strictModelAssignment: true }, cursor: { strictModelAssignment: true } } };
    expect(filterConnectionsForModel("cursor", conns, "mimo/mimo-v2.5", settings)).toEqual(conns);
  });

  it("strict on: only the connection assigned to the requested model survives", () => {
    const settings = { providerStrategies: { freebuff: { strictModelAssignment: true } } };
    const out = filterConnectionsForModel("freebuff", conns, "mimo/mimo-v2.5", settings);
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("strict on: no model requested means no filtering", () => {
    const settings = { providerStrategies: { freebuff: { strictModelAssignment: true } } };
    expect(filterConnectionsForModel("freebuff", conns, null, settings)).toEqual(conns);
  });

  it("strict on: legacy freebuffModel field is honored when assignedModel absent", () => {
    const settings = { providerStrategies: { freebuff: { strictModelAssignment: true } } };
    const legacy = [
      { id: "x", providerSpecificData: { freebuffModel: "deepseek/deepseek-v4-pro" } },
      { id: "y", providerSpecificData: { freebuffModel: "mimo/mimo-v2.5" } },
    ];
    const out = filterConnectionsForModel("freebuff", legacy, "deepseek/deepseek-v4-pro", settings);
    expect(out.map((c) => c.id)).toEqual(["x"]);
  });

  it("strict on: explicit null assignment (unassigned) never matches a model", () => {
    const settings = { providerStrategies: { freebuff: { strictModelAssignment: true } } };
    const out = filterConnectionsForModel("freebuff", conns, "minimax/minimax-m3", settings);
    expect(out).toEqual([]);
  });
});
