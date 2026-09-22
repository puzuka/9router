// Periodic online backups of the live DB — the counterpart of health.js.
//
// The live DB has gone SQLITE_CORRUPT twice in the wild (2026-05, 2026-09);
// before this module the only backups were schema-migration snapshots, so a
// corruption meant a manual `sqlite3 .recover` session with real data loss.
// This scheduler takes a backupDbLite snapshot (all tables except the huge
// requestDetails log → a few MB) under BACKUPS_DIR/auto-<version>-<ts>/ every
// DB_BACKUP_INTERVAL_MINUTES (default 6h), keeping the newest
// DB_BACKUP_KEEP=8. health.js restores from exactly these dirs on startup.
//
// Env switches:
//   DISABLE_DB_BACKUP=1                  — off entirely
//   DB_BACKUP_INTERVAL_MINUTES=<n>       — default 360 (6h)
//   DB_BACKUP_KEEP=<n>                   — default 8
//
// Fail-open everywhere: a failed tick logs a warning and waits for the next
// one; a scheduler error never affects request handling.

import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR } from "./paths.js";
import { makeBackupDir, backupDbLite, pruneAutoBackups, AUTO_BACKUP_PREFIX } from "./backup.js";
import { getAdapter } from "./driver.js";

const STATE_KEY = "__9routerDbAutoBackup__";
const DEFAULT_INTERVAL_MINUTES = 360;
const FIRST_TICK_DELAY_MS = 90 * 1000;

function state() {
  return (globalThis[STATE_KEY] ??= {
    started: false,
    running: false,
    intervalHandle: null,
    initialTimeoutHandle: null,
  });
}

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Next.js build/export phases must not schedule work (mirrors the guard the
// other background keepers use).
function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (["phase-production-build", "phase-export", "phase-static"].includes(phase)) return true;
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

function intervalMs() {
  const n = Number(process.env.DB_BACKUP_INTERVAL_MINUTES);
  const minutes = Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

function keepCount() {
  const n = Number(process.env.DB_BACKUP_KEEP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

// Age of the newest auto backup, or null when none exists yet. Boot-loop
// guard: a restart must not re-backup what the previous run just wrote.
function newestAutoBackupAgeMs() {
  if (!fs.existsSync(BACKUPS_DIR)) return null;
  const dirs = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(AUTO_BACKUP_PREFIX));
  if (dirs.length === 0) return null;
  const newest = Math.max(...dirs.map((e) => {
    try { return fs.statSync(path.join(BACKUPS_DIR, e.name)).mtimeMs; } catch { return 0; }
  }));
  return Date.now() - newest;
}

/**
 * Take one auto backup now (also the exported entry point for tests and ad-hoc
 * calls). Re-entrant-safe: concurrent invocations collapse into one.
 * @returns {{ok: boolean, dir?: string, skipped?: string}}
 */
export async function runAutoBackupOnce() {
  const s = state();
  if (s.running) return { ok: false, skipped: "already-running" };
  s.running = true;
  try {
    const adapter = await getAdapter();
    // Flush WAL before the ATTACH copy so the backup file is self-contained
    // (health.js probes the bare file, sidecars and all).
    adapter.checkpoint?.();
    const dir = makeBackupDir("auto");
    backupDbLite(adapter, dir);
    pruneAutoBackups(keepCount());
    return { ok: true, dir };
  } finally {
    s.running = false;
  }
}

export function startDbAutoBackup() {
  const s = state();
  if (s.started) return false;
  if (isTruthyEnv(process.env.DISABLE_DB_BACKUP)) return false;
  if (isNonServerRuntime()) return false;

  s.started = true;
  const period = intervalMs();

  const safeTick = () => {
    try {
      // Skip when the newest auto backup is still fresh (< half interval) —
      // a container restart or deploy churn must not backup on every boot.
      const age = newestAutoBackupAgeMs();
      if (age != null && age < period / 2) return;
    } catch { /* stat races are fine to ignore */ }
    runAutoBackupOnce()
      .catch((err) => console.warn(`[DB-AutoBackup] tick failed (swallowed): ${err?.message ?? err}`));
  };

  s.initialTimeoutHandle = setTimeout(safeTick, FIRST_TICK_DELAY_MS);
  if (s.initialTimeoutHandle.unref) s.initialTimeoutHandle.unref();
  s.intervalHandle = setInterval(safeTick, period);
  if (s.intervalHandle.unref) s.intervalHandle.unref();
  console.log(`[DB-AutoBackup] scheduler started: every ${Math.round(period / 60000)}min, keep ${keepCount()} (label "${AUTO_BACKUP_PREFIX}")`);
  return true;
}

export function stopDbAutoBackup() {
  const s = state();
  if (!s.started) return false;
  if (s.initialTimeoutHandle) { clearTimeout(s.initialTimeoutHandle); s.initialTimeoutHandle = null; }
  if (s.intervalHandle) { clearInterval(s.intervalHandle); s.intervalHandle = null; }
  s.started = false;
  return true;
}
