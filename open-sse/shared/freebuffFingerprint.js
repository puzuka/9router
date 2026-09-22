import crypto from "node:crypto";
import os from "node:os";
import { execSync } from "node:child_process";
import { getConsistentMachineId } from "./machineId.js";

// CLI-parity fingerprint — replicates the official freebuff/codebuff CLI's
// src/utils/fingerprint.ts v2.0 exactly:
//   enhanced-<base64url(sha256(JSON.stringify(payload)))>
// payload = { system, cpu, os, runtime, network:{macAddresses},
//             machineId, fingerprintVersion:"2.0" }
// The login flow's fingerprintId and the chat body's codebuff_metadata.client_id
// both use this, so the server sees one stable device identity — a plain
// random UUID is trivially distinguishable from every real CLI install.
// Host values are read once and cached; hard failures fall back to sanitized
// empty fields exactly like the CLI's systeminformation catch.

let cachedFingerprint = null;

function safeShell(cmd) {
  try { return String(execSync(cmd, { timeout: 2000, encoding: "utf8" })).trim(); }
  catch { return ""; }
}

function hostSystemInfo() {
  // Mirrors systeminformation's system(): manufacturer/model/serial/uuid.
  const serial = safeShell("cat /sys/class/dmi/id/product_serial 2>/dev/null");
  const uuid = safeShell("cat /sys/class/dmi/id/product_uuid 2>/dev/null");
  const manufacturer = safeShell("cat /sys/class/dmi/id/sys_vendor 2>/dev/null");
  const model = safeShell("cat /sys/class/dmi/id/product_name 2>/dev/null");
  return { manufacturer, model, serial, uuid };
}

function hostCpuInfo() {
  try {
    const cpus = os.cpus();
    const first = cpus[0] || {};
    return {
      manufacturer: (first.model || "").split(/\s+/)[0] || "",
      brand: first.model || "",
      cores: cpus.length,
      physicalCores: Math.max(1, Math.round(cpus.length / 2)),
    };
  } catch {
    return { manufacturer: "", brand: "", cores: 0, physicalCores: 0 };
  }
}

function hostOsInfo() {
  try {
    return {
      platform: os.platform(),
      distro: safeShell(". /etc/os-release 2>/dev/null && echo $ID") || "",
      arch: os.arch(),
      hostname: os.hostname(),
    };
  } catch {
    return { platform: "linux", distro: "", arch: "x64", hostname: "" };
  }
}

function hostRuntime() {
  return {
    nodeVersion: process.version,
    platform: "linux",
    arch: "x64",
    shell: safeShell("echo $SHELL") || "/bin/bash",
    cpuCount: os.cpus().length,
  };
}

function hostNetwork() {
  try {
    const ifaces = os.networkInterfaces();
    const macs = Object.values(ifaces)
      .flat()
      .filter((i) => i && !i.internal && i.mac && i.mac !== "00:00:00:00:00:00")
      .map((i) => i.mac)
      .sort();
    return { macAddresses: macs, interfaceCount: Object.keys(ifaces).length };
  } catch {
    return { macAddresses: [], interfaceCount: 0 };
  }
}

async function rawMachineId() {
  try {
    return await getConsistentMachineId("freebuff-fingerprint");
  } catch {
    return "";
  }
}

export async function getFreebuffCliFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;
  const payload = {
    system: hostSystemInfo(),
    cpu: hostCpuInfo(),
    os: hostOsInfo(),
    runtime: hostRuntime(),
    network: hostNetwork(),
    machineId: await rawMachineId(),
    fingerprintVersion: "2.0",
  };
  cachedFingerprint = `enhanced-${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("base64url")}`;
  return cachedFingerprint;
}

// Sync variant for code paths that cannot await — uses whatever the async
// warm-up cached (empty string until the first async call completes).
export function getCachedFreebuffCliFingerprint() {
  return cachedFingerprint || "";
}
