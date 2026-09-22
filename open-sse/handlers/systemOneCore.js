import { createErrorResult } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

// ── Body validation ────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a systemone body. `state` and `questions` are required objects;
 * each question must declare a `type` and non-empty `criteria`.
 * @returns {string|null} error message or null when valid
 */
export function validateSystemOneBody(body) {
  if (!isPlainObject(body.state)) return "Missing required field: state (object)";
  if (!isPlainObject(body.questions)) return "Missing required field: questions (object)";
  if (Object.keys(body.questions).length === 0) return "questions must not be empty";
  for (const [key, question] of Object.entries(body.questions)) {
    if (!isPlainObject(question)) return `questions.${key} must be an object`;
    if (!question.type || typeof question.type !== "string") return `questions.${key}.type is required`;
    if (!isPlainObject(question.criteria) || Object.keys(question.criteria).length === 0) {
      return `questions.${key}.criteria must be a non-empty object`;
    }
  }
  return null;
}

/**
 * Build the upstream payload. Provider/model routing keys are stripped;
 * everything else the caller sent is forwarded as-is so upstream-side
 * fields (e.g. metadata) keep working without a router release.
 */
export function buildSystemOnePayload({ body, defaultModel }) {
  const payload = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "provider" || key === "stream") continue;
    payload[key] = value;
  }
  payload.model = payload.model || defaultModel;
  return payload;
}

/**
 * Join a compatible-node base URL with the /systemone suffix. A pasted full
 * endpoint must not double up, so a trailing /systemone is normalized away.
 */
export function systemOneNodeEndpoint(baseUrl) {
  let base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (base.endsWith("/systemone")) base = base.slice(0, -"/systemone".length);
  return `${base}/systemone`;
}

/** Find a systemone-compatible node by id or prefix. */
export function findSystemOneNode(nodes, idOrPrefix) {
  if (!idOrPrefix) return null;
  return nodes.find((n) => n.id === idOrPrefix || n.prefix === idOrPrefix) || null;
}

/**
 * Build the synthetic provider entry + config used to route a request to a
 * "System One Compatible" custom node (user-supplied base URL + key pool).
 */
export function buildSystemOneNodeProvider(node) {
  return {
    provider: { id: node.id, display: { name: node.name || node.prefix || node.id } },
    providerConfig: {
      baseUrl: systemOneNodeEndpoint(node.baseUrl),
      method: "POST",
      authType: "apikey",
      authHeader: "bearer",
      defaultModel: node.defaultModel || "jev-latest",
      timeoutMs: 30000,
    },
  };
}

// ── Core handler ───────────────────────────────────────────────

// Strip non-ASCII chars from header values (HTTP headers must be ByteString).
function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = typeof v === "string" ? v.replace(/[^\x00-\xFF]/g, "").trim() : v;
  }
  return out;
}

function errorResult(status, error) {
  return {
    success: false,
    status,
    error,
    response: createErrorResult(status, error),
  };
}

function successResult(data) {
  return { success: true, data, response: new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  }) };
}

/**
 * Core System One handler. POSTs {model, state, questions} to the provider's
 * /v1/systemone endpoint and passes the structured answer envelope through.
 * Same calling convention as handleSearchCore: returns {success, response, status?, error?}.
 *
 * @param {object}   options
 * @param {object}   options.body            Sanitized body from auth wrapper
 * @param {object}   options.provider        Provider entry from AI_PROVIDERS
 * @param {object}   options.providerConfig  Provider's systemOneConfig
 * @param {object|null} options.credentials  Provider credentials
 * @param {object}   [options.log]           Logger
 */
export async function handleSystemOneCore({ body, provider, providerConfig, credentials, log }) {
  const validationError = validateSystemOneBody(body);
  if (validationError) return errorResult(HTTP_STATUS.BAD_REQUEST, validationError);

  const token = credentials?.apiKey || credentials?.accessToken || undefined;
  if (providerConfig.authType !== "none" && !token) {
    return errorResult(HTTP_STATUS.UNAUTHORIZED, `No credentials for provider: ${provider.id}`);
  }

  const payload = buildSystemOnePayload({ body, defaultModel: providerConfig.defaultModel });

  const timeoutMs = providerConfig.timeoutMs || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startTime = Date.now();

  log?.info?.("SYSTEMONE", `${provider.id} | model=${payload.model} | questions=${Object.keys(payload.questions || {}).length}`);

  try {
    const resp = await fetch(providerConfig.baseUrl, {
      method: providerConfig.method || "POST",
      headers: sanitizeHeaders({
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await resp.text();
    if (!resp.ok) {
      log?.error?.("SYSTEMONE", `${provider.id} ${resp.status}: ${text.slice(0, 200)}`);
      return errorResult(resp.status, `${provider.id} returned ${resp.status}: ${text.slice(0, 300)}`);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return errorResult(HTTP_STATUS.BAD_GATEWAY, `${provider.id} returned non-JSON response`);
    }

    const duration = Date.now() - startTime;

    // Router's routing info wins over any same-named field in the upstream body
    return successResult({
      ...data,
      provider: provider.id,
      metrics: { response_time_ms: duration },
      errors: [],
    });
  } catch (err) {
    const isTimeout = err.name === "AbortError";
    const status = isTimeout ? 504 : 502;
    log?.error?.("SYSTEMONE", `${provider.id} ${isTimeout ? "timeout" : "error"}: ${err.message}`);
    return errorResult(status, `${provider.id} ${isTimeout ? "timeout" : "error"}: ${err.message}`);
  }
}
