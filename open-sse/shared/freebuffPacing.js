// Shared Freebuff request pacing registry — used by BOTH the executor (request
// gate) and the keeper (so both agree on the same per-account clock).
//
// An account that serves 25 requests in 9 minutes with 15–60s gaps (what
// preceded a real ban) is an anti-abuse signature. Pacing enforces a minimum
// idle gap between requests on the same Freebuff token: when the gap hasn't
// elapsed, the executor fails fast with 429 + resetsAtMs so account fallback
// rotates to another account instead of hammering the same one.
//
// All state lives on globalThis so Next dev (Turbopack) bundles share ONE copy
// (same pattern as the executor's freebuff fbState). Tokens are only ever
// hashed here — never stored, never logged.

import { PROVIDERS } from "../providers/index.js";

const FB_PACING_KEY = "__9routerFreebuffPacing__";
// Fallback when the provider declares no pacing block and no env override is
// set. Keep in sync with freebuff's `pacing.gapSeconds` (20s).
const DEFAULT_PACING_GAP_MS = 20 * 1000;
const DEFAULT_MAX_WAIT_MS = 30 * 1000;

function pacingState() {
  return (globalThis[FB_PACING_KEY] ??= {
    lastRequestAt: new Map(), // hashToken -> ms of the last accepted request
  });
}

// Stable short hash for an opaque token — never store/log the token itself.
export function hashFreebuffToken(token) {
  if (typeof token !== "string" || token.length === 0) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Pacing config lives on the provider registry entry (registry/freebuff.js
// `pacing.gapSeconds`), read through the built PROVIDERS table so one edit
// retunes every consumer — the executor gate and the keeper's ad clock read
// the SAME number instead of duplicating a constant. Read lazily (not at module
// load) so a registry change is picked up without a process restart.
function providerPacing() {
  return PROVIDERS.freebuff?.pacing || null;
}

// Dashboard override — the per-provider "Pacing Gap" setting. Null means the
// user never set one, so the resolution falls through to env/registry/default.
// Lives in memory and is re-primed from settings on startup and on every
// settings PATCH, so changing the dashboard field applies without a restart.
let pacingGapMsOverride = null;

export function setFreebuffPacingGapMsOverride(ms) {
  const n = Number(ms);
  pacingGapMsOverride = Number.isFinite(n) && n > 0 ? n : null;
}

export function getFreebuffPacingGapMsOverride() {
  return pacingGapMsOverride;
}

/**
 * Prime the pacing override from a settings object.
 *
 * Read from `providerStrategies.freebuff.pacingGapSeconds` — the same slot that
 * already carries freebuff's `strictModelAssignment`, so one provider-scoped
 * bag holds every freebuff knob and the dashboard reads/writes them through one
 * PATCH path. A missing, empty, or non-numeric value clears the override and
 * hands control back to the registry default (20s), which is what "not set"
 * has to mean or the field would silently pin a stale number forever.
 */
export function applyFreebuffPacingSettings(settings) {
  const raw = settings?.providerStrategies?.freebuff?.pacingGapSeconds;
  const seconds = Number(raw);
  setFreebuffPacingGapMsOverride(
    raw !== null && raw !== undefined && raw !== "" && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : null,
  );
  return pacingGapMsOverride;
}

/**
 * Minimum idle gap between two requests on the same Freebuff account, in ms.
 *
 * Resolution order: dashboard setting (`providerStrategies.freebuff
 * .pacingGapSeconds`) → FREEBUFF_PACING_GAP_MS → provider `pacing.gapSeconds`
 * → built-in default.
 *
 * The dashboard wins over the env var on purpose: this is a single-user
 * gateway whose operator IS the person clicking in the UI, so "what you see in
 * the dashboard is what runs" beats a hidden deployment-wide value. The env
 * var stays for headless/CI runs that have no dashboard to click.
 */
export function getFreebuffPacingGapMs() {
  if (pacingGapMsOverride !== null) return pacingGapMsOverride;
  const env = Number(process.env.FREEBUFF_PACING_GAP_MS);
  if (Number.isFinite(env) && env > 0) return env;
  const seconds = Number(providerPacing()?.gapSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return DEFAULT_PACING_GAP_MS;
}

/** The gap the dashboard should show as the effective value, in seconds. */
export function getEffectiveFreebuffPacingGapSeconds() {
  return getFreebuffPacingGapMs() / 1000;
}

// Upper bound for the single-account bounded wait (chat.js). When every
// Freebuff account is pacing/model-locked and the earliest lock resolves
// within this window, the handler waits it out instead of failing the
// request with 429 — there is nobody to fall back to with one account.
export function getFreebuffMaxWaitMs() {
  const env = Number(process.env.FREEBUFF_MAX_WAIT_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_WAIT_MS;
}

/**
 * How long the handler should wait before retrying the same account.
 * Returns 0 when there is nothing to wait for, the lock is already expired,
 * or the wait would exceed the bounded max (fail fast instead).
 *
 * `retryAfter` accepts any of: absolute epoch ms (number), ISO string
 * (what auth.js returns via getEarliestModelLockUntil), or a Date.
 */
export function computeFreebuffWaitMs(retryAfter, nowMs = Date.now()) {
  if (retryAfter == null) return 0;
  let t;
  if (retryAfter instanceof Date) {
    t = retryAfter.getTime();
  } else if (typeof retryAfter === "string") {
    t = new Date(retryAfter).getTime();
  } else {
    t = Number(retryAfter);
  }
  if (!Number.isFinite(t)) return 0;
  const waitMs = t - nowMs;
  if (waitMs <= 0) return 0;
  const max = getFreebuffMaxWaitMs();
  return waitMs <= max ? waitMs : 0;
}

/** Milliseconds until the next allowed request for this token (0 = allowed now). */
export function freebuffPacingRemainingMs(token, nowMs = Date.now()) {
  const key = hashFreebuffToken(token);
  if (!key) return 0;
  const last = pacingState().lastRequestAt.get(key) || 0;
  if (!last) return 0; // never called before — allowed immediately
  const gap = getFreebuffPacingGapMs();
  return Math.max(0, gap - (nowMs - last));
}

/**
 * Try to acquire the request slot for this token. Returns true (and records
 * the timestamp) when the pacing gap has elapsed; false when the caller
 * should back off until freebuffPacingRemainingMs().
 */
export function acquireFreebuffRequestSlot(token, nowMs = Date.now()) {
  const remaining = freebuffPacingRemainingMs(token, nowMs);
  if (remaining > 0) return false;
  pacingState().lastRequestAt.set(hashFreebuffToken(token), nowMs);
  return true;
}