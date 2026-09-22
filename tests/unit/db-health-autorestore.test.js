import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// DATA_DIR must be set before any db module is imported — paths.js resolves it
// at import time. Every db module below is therefore imported dynamically
// (same pattern as request-details-tab.test.js).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-db-health-"));
process.env.DATA_DIR = path.join(tmpRoot, "data");
const originalKeep = process.env.DB_BACKUP_KEEP;

let DATA_FILE;
let BACKUPS_DIR;
let health;

beforeAll(async () => {
  ({ DATA_FILE, BACKUPS_DIR } = await import("../../src/lib/db/paths.js"));
  health = await import("../../src/lib/db/health.js");
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (originalKeep === undefined) delete process.env.DB_BACKUP_KEEP;
  else process.env.DB_BACKUP_KEEP = originalKeep;
});

// node:sqlite DatabaseSync is used on every runtime that runs this suite
// (better-sqlite3 native bindings are skipped on Node >= 24 — see driver.js).
function openSqlite(filePath) {
  return new DatabaseSync(filePath);
}

function makePopulatedDb(filePath, { rows = 3000 } = {}) {
  const db = openSqlite(filePath);
  db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO probe (note) VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run(`row-${i}`);
  db.close();
  return filePath;
}

// Smash whole pages (3-4, the b-tree area past the header/schema pages) with
// 0xFF. Deterministic corruption: quick_check reports malformed pages, or the
// open itself fails — either way probeSqliteFile must say "not ok".
function corruptSqliteFile(filePath) {
  const buf = fs.readFileSync(filePath);
  buf.fill(0xff, 8192, Math.min(buf.length, 16384));
  fs.writeFileSync(filePath, buf);
}

describe("probeSqliteFile", () => {
  it("returns true for a healthy populated sqlite file", () => {
    const f = makePopulatedDb(path.join(tmpRoot, "healthy.sqlite"));
    expect(health.probeSqliteFile(f)).resolves.toBe(true);
  });

  it("returns true for a missing file (fresh installs are not corruption)", () => {
    expect(health.probeSqliteFile(path.join(tmpRoot, "nope.sqlite"))).resolves.toBe(true);
  });

  it("returns false for a non-sqlite garbage file", () => {
    const f = path.join(tmpRoot, "garbage.sqlite");
    fs.writeFileSync(f, Buffer.from("this is definitely not a sqlite database file"));
    expect(health.probeSqliteFile(f)).resolves.toBe(false);
  });

  it("returns false for a corrupted sqlite file", () => {
    const f = makePopulatedDb(path.join(tmpRoot, "corrupt.sqlite"));
    corruptSqliteFile(f);
    expect(health.probeSqliteFile(f)).resolves.toBe(false);
  });
});

describe("db auto-backup + restore (health gate)", () => {
  it("runAutoBackupOnce snapshots the live DB into an auto-* dir, content intact", async () => {
    const { getAdapter } = await import("../../src/lib/db/driver.js");
    const { runAutoBackupOnce } = await import("../../src/lib/db/autoBackup.js");
    const adapter = await getAdapter();
    adapter.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
    const insert = adapter.raw.prepare("INSERT INTO probe (note) VALUES (?)");
    insert.run("live-row-1");

    const result = await runAutoBackupOnce();
    expect(result.ok).toBe(true);

    const backupFile = path.join(result.dir, "data.sqlite");
    expect(fs.existsSync(backupFile)).toBe(true);
    await expect(health.probeSqliteFile(backupFile)).resolves.toBe(true);
    const bak = openSqlite(backupFile);
    expect(bak.prepare("SELECT COUNT(*) c FROM probe").get().c).toBe(1);
    bak.close();
  });

  it("ensureHealthyDataFile restores the newest GOOD auto backup over a corrupt live file", async () => {
    const autoDirs = fs.readdirSync(BACKUPS_DIR).filter((d) => d.startsWith("auto-"));
    expect(autoDirs.length).toBeGreaterThanOrEqual(1);

    // A NEWER auto backup that is itself corrupt must be skipped in favor of
    // the older healthy one (name "auto-zzz-*" sorts after the real dir).
    const decoyDir = path.join(BACKUPS_DIR, "auto-zzz-corrupt-decoy");
    fs.mkdirSync(decoyDir, { recursive: true });
    makePopulatedDb(path.join(decoyDir, "data.sqlite"));
    corruptSqliteFile(path.join(decoyDir, "data.sqlite"));

    corruptSqliteFile(DATA_FILE);
    const outcome = await health.ensureHealthyDataFile();
    expect(outcome.healthy).toBe(true);
    expect(outcome.restored).toBe(true);
    // The decoy was skipped, not chosen.
    expect(outcome.from).not.toContain("decoy");

    await expect(health.probeSqliteFile(DATA_FILE)).resolves.toBe(true);
    const db = openSqlite(DATA_FILE);
    expect(db.prepare("SELECT COUNT(*) c FROM probe").get().c).toBe(1);
    db.close();

    // The corrupt live file was quarantined, not silently discarded.
    const quarantined = fs.readdirSync(BACKUPS_DIR).filter((d) => d.startsWith("corrupt-"));
    expect(quarantined.length).toBeGreaterThanOrEqual(1);
  });

  it("ensureHealthyDataFile leaves a healthy file alone", async () => {
    const outcome = await health.ensureHealthyDataFile();
    expect(outcome.healthy).toBe(true);
    expect(outcome.restored).toBe(false);
  });

  it("with no good auto backup, the corrupt file stays in place (fail-open)", async () => {
    for (const d of fs.readdirSync(BACKUPS_DIR).filter((d) => d.startsWith("auto-"))) {
      fs.rmSync(path.join(BACKUPS_DIR, d), { recursive: true, force: true });
    }
    corruptSqliteFile(DATA_FILE);
    const outcome = await health.ensureHealthyDataFile();
    expect(outcome.healthy).toBe(false);
    expect(outcome.restored).toBe(false);
    await expect(health.probeSqliteFile(DATA_FILE)).resolves.toBe(false);
  });
});

describe("pruneAutoBackups / pruneOldBackups separation", () => {
  it("prunes only auto-* dirs and never migration snapshots or quarantines", async () => {
    const { pruneAutoBackups, pruneOldBackups } = await import("../../src/lib/db/backup.js");
    const stamp = (d, name) => {
      const dir = path.join(BACKUPS_DIR, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "marker"), "x");
      // Date objects — bare numbers are interpreted as seconds, and the huge
      // ms value clamps to a saturated timestamp for every dir equally.
      fs.utimesSync(dir, new Date(d), new Date(d));
    };
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    for (let i = 0; i < 5; i += 1) stamp(base + i * 1000, `auto-fake-20260101-00000${i}`);
    stamp(base + 100, "schema-0-to-1-fake");
    stamp(base + 100, "corrupt-fake");

    pruneAutoBackups(3);
    const names = fs.readdirSync(BACKUPS_DIR);
    const autos = names.filter((n) => n.startsWith("auto-fake")).sort();
    expect(autos).toHaveLength(3);
    expect(autos[autos.length - 1]).toBe("auto-fake-20260101-000004");
    expect(names).toContain("schema-0-to-1-fake");
    expect(names).toContain("corrupt-fake");

    // pruneOldBackups (migration-time prune) must not touch auto-* dirs.
    pruneOldBackups();
    expect(fs.readdirSync(BACKUPS_DIR).filter((n) => n.startsWith("auto-fake"))).toHaveLength(3);
  });
});
