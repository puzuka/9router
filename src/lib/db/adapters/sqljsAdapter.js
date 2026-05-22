import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";

let SQL = null;
const SQLJS_PRAGMA_SQL = PRAGMA_SQL.replace("PRAGMA journal_mode = WAL;", "PRAGMA journal_mode = DELETE;");

async function loadSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

function assertNoNativeSidecars(filePath) {
  const sidecars = [`${filePath}-wal`, `${filePath}-shm`].filter((sidecar) => fs.existsSync(sidecar) && fs.statSync(sidecar).size > 0);
  if (sidecars.length > 0) {
    throw new Error(`Refusing sql.js fallback while native SQLite sidecars exist: ${sidecars.join(", ")}`);
  }
}

function acquireLock(lockPath) {
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    let stale = false;
    try {
      const pid = Number(fs.readFileSync(lockPath, "utf8").trim().split(/\s+/)[0]);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (probeError) {
          stale = probeError.code === "ESRCH";
        }
      }
    } catch {}

    if (stale) {
      try { fs.rmSync(lockPath, { force: true }); } catch {}
      return acquireLock(lockPath);
    }

    throw new Error(`Refusing sql.js fallback because ${lockPath} already exists`);
  }
}

function releaseLock(lockPath, fd) {
  try { fs.closeSync(fd); } catch {}
  try { fs.rmSync(lockPath, { force: true }); } catch {}
}

function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd = null;

  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);

    try {
      const dirFd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {}
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

export async function createSqlJsAdapter(filePath) {
  assertNoNativeSidecars(filePath);
  const lockPath = `${filePath}.sqljs.lock`;
  const lockFd = acquireLock(lockPath);
  let db = null;
  try {
    const SQLLib = await loadSql();
    const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    db = new SQLLib.Database(buf);
    db.exec(SQLJS_PRAGMA_SQL);
    // Schema is created/synced by migrate.js after adapter init

    let dirty = false;
    let saveTimer = null;
    const SAVE_DEBOUNCE_MS = 100;

    function persist() {
      const data = db.export();
      atomicWriteFile(filePath, Buffer.from(data));
      dirty = false;
    }

    function scheduleSave() {
      dirty = true;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        if (dirty) {
          try { persist(); } catch (e) { console.error("[sqljs] save failed:", e); }
        }
      }, SAVE_DEBOUNCE_MS);
    }

    function paramsObj(params) {
      if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
      return params;
    }

    function run(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(paramsObj(params));
        stmt.step();
        const changes = db.getRowsModified();
        const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
        scheduleSave();
        return { changes, lastInsertRowid };
      } finally {
        stmt.free();
      }
    }

    function get(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(paramsObj(params));
        if (stmt.step()) return stmt.getAsObject();
        return undefined;
      } finally {
        stmt.free();
      }
    }

    function all(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(paramsObj(params));
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    }

    function exec(sql) {
      db.exec(sql);
      scheduleSave();
    }

    function transaction(fn) {
      const sp = `sp_${Math.random().toString(36).slice(2)}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${sp}`);
        scheduleSave();
        return result;
      } catch (e) {
        try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
        throw e;
      }
    }

    function close() {
      if (saveTimer) clearTimeout(saveTimer);
      try {
        if (dirty) persist();
      } finally {
        db.close();
        releaseLock(lockPath, lockFd);
      }
    }

    // Flush on shutdown
    const flush = () => { if (dirty) try { persist(); } catch {} };
    process.on("beforeExit", flush);
    process.on("SIGINT", flush);
    process.on("SIGTERM", flush);
    process.once("exit", () => releaseLock(lockPath, lockFd));

    return { driver: "sql.js", run, get, all, exec, transaction, close, raw: db };
  } catch (error) {
    if (db) {
      try { db.close(); } catch {}
    }
    releaseLock(lockPath, lockFd);
    throw error;
  }
}
