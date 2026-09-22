// DB health gate — probe the sqlite file before the app binds an adapter to
// it, quarantine a corrupt file, and restore the newest good auto backup.
//
// Why this exists: the live DB has been corrupted twice in the wild (2026-05,
// 2026-09) with SQLITE_CORRUPT "database disk image is malformed" —
// double-referenced pages plus broken index trees. Without this gate the file
// opens fine and every runtime query then fails; recovery was a manual
// `sqlite3 .recover` session. With the gate, a corrupt file is swapped for the
// newest healthy auto backup (see autoBackup.js) before any query runs.
//
// Everything here is fail-open: an unavailable probe driver is treated as
// "can't judge, assume healthy" (never quarantine a file we cannot check), and
// any unexpected error leaves the file untouched.

import fs from "node:fs";
import path from "node:path";
import { DATA_FILE, BACKUPS_DIR, ensureDirs } from "./paths.js";
import { timestampSlug } from "./version.js";

// Only auto-* dirs are restore candidates. Migration snapshots (schema-…),
// manual recoveries (recover-…) and quarantined corrupt files never are: their
// data is a point-in-time migration state, not a live restore source.
const AUTO_BACKUP_PREFIX = "auto-";

function openProbeDatabase(filePath) {
  if (process.versions.bun) {
    // bun:sqlite mirrors the better-sqlite3 API (prepare/all/close).
    return import("bun:sqlite").then(({ Database }) => new Database(filePath));
  }
  const nodeMajor = Number(process.versions.node.split(".")[0] || 0);
  if (nodeMajor < 24) {
    // Same driver order as driver.js; better-sqlite3 SIGSEGVs on Node >= 24,
    // so that range must go straight to node:sqlite.
    return import("better-sqlite3")
      .then((mod) => new (mod.default ?? mod)(filePath))
      .catch(() => import("node:sqlite").then(({ DatabaseSync }) => new DatabaseSync(filePath)));
  }
  return import("node:sqlite").then(({ DatabaseSync }) => new DatabaseSync(filePath));
}

/**
 * Run PRAGMA quick_check against a sqlite file with a short-lived throwaway
 * connection. Never throws.
 * @returns {boolean} true when the file is healthy, absent, or unverifiable;
 *   false only when a driver definitively reports corruption.
 */
export async function probeSqliteFile(filePath) {
  if (!fs.existsSync(filePath)) return true;
  let db = null;
  try {
    db = await openProbeDatabase(filePath);
  } catch {
    // No probe driver on this runtime → cannot judge → assume healthy.
    return true;
  }
  try {
    const rows = db.prepare("PRAGMA quick_check").all();
    return rows.every((row) => String(Object.values(row)[0] ?? "").toLowerCase() === "ok");
  } catch {
    return false;
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Copy a corrupt DB (plus WAL/SHM sidecars) into BACKUPS_DIR/corrupt-<ts>/.
 * Copy, not move: with no good backup to restore, the live file stays in place
 * exactly as before, so this is always safe to run.
 * @returns {string|null} quarantine directory, or null when nothing was copied.
 */
export function quarantineCorruptDb() {
  ensureDirs();
  const dir = path.join(BACKUPS_DIR, `corrupt-${timestampSlug()}`);
  const files = [DATA_FILE, `${DATA_FILE}-wal`, `${DATA_FILE}-shm`].filter((f) => fs.existsSync(f));
  if (files.length === 0) return null;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    try { fs.copyFileSync(f, path.join(dir, path.basename(f))); } catch {}
  }
  return dir;
}

/**
 * Newest auto backup whose data.sqlite passes quick_check, or null.
 * Dir names embed timestampSlug() so a name sort is a time sort.
 */
export async function findLatestGoodAutoBackup() {
  if (!fs.existsSync(BACKUPS_DIR)) return null;
  const dirs = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(AUTO_BACKUP_PREFIX))
    .map((e) => path.join(BACKUPS_DIR, e.name))
    .sort((a, b) => b.localeCompare(a));
  for (const dir of dirs) {
    const candidate = path.join(dir, "data.sqlite");
    if (!fs.existsSync(candidate)) continue;
    if (await probeSqliteFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Overwrite DATA_FILE with the newest good auto backup (stale WAL/SHM removed
 * first — a checkpointed backup is authoritative on its own).
 * @returns {{restored: boolean, from?: string}}
 */
export async function restoreLatestGoodBackup() {
  const candidate = await findLatestGoodAutoBackup();
  if (!candidate) return { restored: false };
  for (const side of [`${DATA_FILE}-wal`, `${DATA_FILE}-shm`]) {
    if (fs.existsSync(side)) { try { fs.rmSync(side, { force: true }); } catch {} }
  }
  fs.copyFileSync(candidate, DATA_FILE);
  return { restored: true, from: candidate };
}

/**
 * Startup gate for driver.js: probe DATA_FILE; when corrupt, quarantine it and
 * swap in the newest good auto backup. With no restorable backup the file is
 * left in place (pre-gate behavior) with a loud pointer to the quarantine copy.
 * Never throws.
 */
export async function ensureHealthyDataFile() {
  if (!fs.existsSync(DATA_FILE)) return { healthy: true, restored: false };
  if (await probeSqliteFile(DATA_FILE)) return { healthy: true, restored: false };

  const quarantineDir = quarantineCorruptDb();
  const { restored, from } = await restoreLatestGoodBackup();
  if (restored) {
    console.warn(`[DB] data.sqlite was corrupt (SQLITE_CORRUPT). Quarantined to ${quarantineDir}; restored from ${from}.`);
    return { healthy: true, restored: true, from };
  }
  console.warn(
    `[DB] data.sqlite is corrupt and no good ${AUTO_BACKUP_PREFIX}* backup exists. ` +
    `File left in place (queries will fail) — corrupt copy saved to ${quarantineDir}. ` +
    `Repair manually (sqlite3 .recover) or wait for the next auto backup after replacing the file.`,
  );
  return { healthy: false, restored: false, quarantineDir };
}
