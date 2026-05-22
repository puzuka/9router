// Verify safe driver fallback: native SQLite first, sql.js only by explicit opt-in.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;
const originalSqlJsFallback = process.env.NINEROUTER_ENABLE_SQLJS_FALLBACK;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-chain-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.NINEROUTER_ENABLE_SQLJS_FALLBACK;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalSqlJsFallback === undefined) delete process.env.NINEROUTER_ENABLE_SQLJS_FALLBACK;
  else process.env.NINEROUTER_ENABLE_SQLJS_FALLBACK = originalSqlJsFallback;
});

describe("Driver fallback chain", () => {
  it("default → picks a native SQLite driver", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(["better-sqlite3", "node:sqlite", "bun:sqlite"]).toContain(db.driver);
  });

  it("falls back to node:sqlite when better-sqlite3 unavailable", async () => {
    // Mock the better-sqlite3 adapter to throw
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      return {
        createBetterSqliteAdapter: () => { throw new Error("simulated unavailable"); },
      };
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    // Node 22.5+ should give node:sqlite. Older Node should fail closed unless sql.js is opted in.
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) {
      const db = await getAdapter();
      expect(db.driver).toBe("node:sqlite");
    } else {
      await expect(getAdapter()).rejects.toThrow(/No safe SQLite driver available/);
    }
  });

  it("fails closed when both native drivers are unavailable and sql.js is not opted in", async () => {
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      return {
        createBetterSqliteAdapter: () => { throw new Error("simulated unavailable"); },
      };
    });
    vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
      return {
        createNodeSqliteAdapter: () => { throw new Error("simulated unavailable"); },
      };
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    await expect(getAdapter()).rejects.toThrow(/No safe SQLite driver available/);
  });

  it("falls back to sql.js only when explicitly opted in", async () => {
    process.env.NINEROUTER_ENABLE_SQLJS_FALLBACK = "1";
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      return {
        createBetterSqliteAdapter: () => { throw new Error("simulated unavailable"); },
      };
    });
    vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
      return {
        createNodeSqliteAdapter: () => { throw new Error("simulated unavailable"); },
      };
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.driver).toBe("sql.js");
  });

  it("refuses sql.js fallback when native sidecars exist", async () => {
    process.env.NINEROUTER_ENABLE_SQLJS_FALLBACK = "1";
    const dbDir = path.join(tempDir, "db");
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, "data.sqlite-shm"), Buffer.alloc(1));

    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      return {
        createBetterSqliteAdapter: () => { throw new Error("simulated unavailable"); },
      };
    });
    vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
      return {
        createNodeSqliteAdapter: () => { throw new Error("simulated unavailable"); },
      };
    });

    const { getAdapter } = await import("@/lib/db/driver.js");
    await expect(getAdapter()).rejects.toThrow(/native SQLite sidecars exist/);
  });
});
