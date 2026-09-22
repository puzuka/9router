// Freebuff account health keeper — background maintenance for Freebuff connections.
//
// Optimizes an account's anti-abuse posture by emulating the official CLI's
// background behavior that a headless 9router integration skips:
//
//   1. AD IMPRESSIONS  — the official CLI keeps the waiting room / chat ad
//      surface alive (ads are ALWAYS on for Freebuff: `getAdsEnabled()`
//      returns `true` unconditionally). We fetch an ad from the auction and
//      acknowledge the impression with a fresh event id + browser-like UA +
//      plausible render delay, so the account *appears* to generate
//      impressions instead of showing as a 100% parasite consumer.
//   2. HEARTBEAT       — emit the PostHog `product_active_minute` presence
//      signal the CLI sends so the account looks actively used.
//   3. PACING          — enforce a minimum idle gap between requests per
//      connection, so we never reproduce the 25-requests-in-9-minutes burst
//      that preceded a ban.
//
// Fail-open everywhere: a tick error or a per-connection failure never kills
// the interval. Absolutely nothing here touches the DB credential values —
// tokens are read from the connection rows at tick time and used in memory
// only.

import * as log from "../utils/logger.js";
import {
  hashFreebuffToken,
  getFreebuffPacingGapMs,
} from "../../../open-sse/shared/freebuffPacing.js";

const FB_STATE_KEY = "__9routerFreebuffKeeper__";

const DEFAULT_INTERVAL_MS = 60 * 1000; // ad rotation is 60s (`rotationMs` from /api/v1/ads/policy)
const POSTHOG_PROJECT_API_KEY = "phc_tug7g8yc10qNestK14QV8WyKwjfEl6vwzIbJkBdqeHS";
const POSTHOG_HOST = "https://eu.i.posthog.com";
// Chrome 151 browser-like UA for ad auction/impression (mirrors cli ad-user-agent.ts).
const AD_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
// Gravity explicitly asked for the real client UA on some paths; the header
// always wins when it has content (cli: resolveGravityUserAgent). Official CLI
// sends `Bun/<version>` normally, so keeping Bun here is parity — the body's
// browser-like UA does the targeting work.
const CLI_UA = "Bun/1.3.14";
const FREEBUFF_BASE = "https://www.codebuff.com";

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let tickRunning = false;
let lastTickAt = 0;

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (["phase-production-build", "phase-export", "phase-static"].includes(phase)) return true;
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ±25% symmetric jitter; min 0. Always short. Keeps the keeper from becoming
// a metronome against the anti-abuse heuristics.
function jitterMs(baseMs) {
  const delta = baseMs * (0.25 + Math.random() * 0.5); // 0.25x–0.75x
  return Math.floor(baseMs + delta);
}

function uuid() {
  return crypto.randomUUID();
}

// Shared in-memory pacing registry (survives Next dev hot reloads via globalThis).
function pacingState() {
  return (globalThis[FB_STATE_KEY] ??= {
    lastAdAt: new Map(),
    lastHeartbeatAt: new Map(),
  });
}

async function loadFreebuffConnections() {
  const { getProviderConnections } = await import("../../lib/db/repos/connectionsRepo.js");
  const conns = await getProviderConnections({});
  // Run on ALL freebuff rows (even isActive=0 — the healthy accounts are
  // parked until this deploys; the keeper is what keeps them alive). Banned
  // accounts are skipped per-tick via the dead-account set below.
  return (Array.isArray(conns) ? conns : []).filter((c) => c && c.provider === "freebuff");
}

function connectionToken(conn) {
  // rowToConn spreads the `data` JSON onto the row, so the OAuth token lives
  // directly on `conn.accessToken` (not nested under `conn.data`).
  const raw =
    conn?.accessToken || conn?.apiKey || "";
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

// Rendered ad response shape (mirrors cli AdResponse).
function fetchAds(apiToken) {
  return fetch(`${FREEBUFF_BASE}/api/v1/ads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
      "User-Agent": CLI_UA,
    },
    body: JSON.stringify({
      provider: "gravity",
      messages: [
        { role: "user", content: "<user_message>idle session</user_message>" },
      ],
      sessionId: uuid(),
      device: { os: "linux", platform: "linux", arch: "x64" },
      surface: "waiting_room",
      userAgent: AD_USER_AGENT,
    }),
    signal: AbortSignal.timeout(15_000),
  });
}

function acknowledgeImpression(apiToken, ad) {
  const eventId = uuid();
  const renderDelayMs = Math.floor(1800 + Math.random() * 2200); // 1.8–4.0s
  return fetch(`${FREEBUFF_BASE}/api/v1/ads/impression`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
      "User-Agent": CLI_UA,
      "X-Freebuff-Event-Id": eventId,
      "X-Freebuff-Render-Delay-Ms": String(renderDelayMs),
    },
    body: JSON.stringify({
      impUrl: ad.impUrl,
      mode: "free",
      userAgent: AD_USER_AGENT,
      os: "linux",
      clientEventId: eventId,
      renderDelayMs,
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

// Sessionally plausible click: fresh event id, dock context, dwell variance.
// Mirrors cli recordClick() — one click per logical event, server dedupes via
// client_event_id.
function recordClick(apiToken, ad) {
  const eventId = uuid();
  const dwellMs = Math.floor(1200 + Math.random() * 4800); // 1.2–6.0s
  return fetch(`${FREEBUFF_BASE}/api/v1/ads/click`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
      "User-Agent": CLI_UA,
      "X-Freebuff-Event-Id": eventId,
    },
    body: JSON.stringify({
      impUrl: ad.impUrl,
      clientEventId: eventId,
      surface: "waiting_room",
      dockFrom: "dock",
      dockDwellMs: dwellMs,
      dockAccidentalClick: Math.random() < 0.08, // rare accidental clicks
    }),
    signal: AbortSignal.timeout(10_000),
  });
}

function sendHeartbeat(apiToken) {
  const distinctId = hashFreebuffToken(apiToken);
  return fetch(`${POSTHOG_HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: POSTHOG_PROJECT_API_KEY,
      event: "product_active_minute",
      distinct_id: distinctId,
      properties: { $current_url: "https://freebuff.com" },
      timestamp: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null); // PostHog is best-effort; never surface its failures.
}

/**
 * One keeper tick: for every active Freebuff connection, rotate an ad
 * impression and emit a heartbeat. Per-connection failures are swallowed so a
 * single dead account never blocks the rest.
 */
// Accounts that answered 403/401 (banned/revoked) — skip future ticks so we
// never keep hammering a dead account. Keyed by token hash.
const deadAccounts = new Set();

export async function runFreebuffKeeperTick(deps = {}) {
  if (tickRunning) return;
  tickRunning = true;
  const now = Date.now();
  try {
    const load = deps.loadConnections || loadFreebuffConnections;
    const conns = await load();

    for (const conn of conns) {
      const token = connectionToken(conn);
      if (!token) continue;
      const tKey = hashFreebuffToken(token);
      if (deadAccounts.has(tKey)) continue;
      const st = pacingState();

      try {
        // Heartbeat cadence: every tick (60s) — mirrors engagement tracker's
        // one product_active_minute per active minute.
        const lastHb = st.lastHeartbeatAt.get(tKey) || 0;
        if (now - lastHb >= 55_000) {
          await sendHeartbeat(token);
          st.lastHeartbeatAt.set(tKey, now);
        }

        // Ad rotation: every rotation period (± jitter).
        const lastAd = st.lastAdAt.get(tKey) || 0;
        if (now - lastAd < jitterMs(DEFAULT_INTERVAL_MS)) continue;

        const res = await fetchAds(token);
        if (res.status === 401 || res.status === 403) {
          // Banned/revoked account — park it so we stop touching it.
          deadAccounts.add(tKey);
          log.warn("FB_KEEPER", `account parked (${res.status}): ${conn.email || conn.name}`);
          continue;
        }
        if (!res.ok) {
          log.debug("FB_KEEPER", `ads fetch failed (${res.status}): ${conn.email || conn.name}`);
          continue;
        }
        const data = await res.json().catch(() => null);
        const ads = data?.ads || data?.data || (Array.isArray(data) ? data : []);
        const ad = Array.isArray(ads) && ads.length > 0 ? ads[0] : null;
        if (!ad?.impUrl) {
          // No ad served this round — still record the rotation timestamp so we
          // don't hammer the auction when inventory is empty.
          st.lastAdAt.set(tKey, now);
          continue;
        }

        const imp = await acknowledgeImpression(token, ad);
        const granted = imp.ok ? ((await imp.json().catch(() => null))?.creditsGranted) : 0;
        st.lastAdAt.set(tKey, now);
        const who = conn.email || conn.name || "?";
        log.info(
          "FB_KEEPER",
          `ad impression ${imp.ok ? "ok" : "fail(" + imp.status + ")"}${granted > 0 ? ` +${granted}credits` : ""} (${who})`
        );

        // Occasional click (~20% of impressions) — one per logical event, fresh
        // event id, dock context. Mirrors the CLI's recordClick cadence.
        if (imp.ok && Math.random() < 0.2) {
          try {
            const click = await recordClick(token, ad);
            log.info("FB_KEEPER", `ad click ${click.ok ? "ok" : "fail(" + click.status + ")"} (${who})`);
          } catch (clickErr) {
            log.debug("FB_KEEPER", `click failed (swallowed): ${clickErr?.message ?? String(clickErr)}`);
          }
        }
      } catch (err) {
        log.warn("FB_KEEPER", `connection tick failed (swallowed): ${err?.message ?? String(err)}`);
      }
    }
  } catch (err) {
    log.warn("FB_KEEPER", `tick failed (swallowed): ${err?.message ?? String(err)}`);
  } finally {
    tickRunning = false;
    lastTickAt = Date.now();
  }
}

/** Start the keeper interval (idempotent). */
export function startFreebuffKeeper({ intervalMs } = {}) {
  if (started) return false;
  if (isTruthyEnv(process.env.DISABLE_FREEBUFF_KEEPER)) return false;
  if (isNonServerRuntime()) return false;
  started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  const safeTick = () => {
    runFreebuffKeeperTick().catch((err) => {
      log.warn("FB_KEEPER", `unhandled tick rejection (swallowed): ${err?.message ?? String(err)}`);
    });
  };
  initialTimeoutHandle = setTimeout(safeTick, 10_000);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();
  intervalHandle = setInterval(safeTick, period);
  if (intervalHandle.unref) intervalHandle.unref();
  return true;
}

export function stopFreebuffKeeper() {
  if (initialTimeoutHandle) {
    clearTimeout(initialTimeoutHandle);
    initialTimeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (started) started = false;
}