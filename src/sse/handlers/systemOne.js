import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings, getProviderNodes } from "@/lib/localDb";
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers.js";
import { handleSystemOneCore, findSystemOneNode, buildSystemOneNodeProvider } from "open-sse/handlers/systemOneCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { enforceQuota, recordSuccessfulUsage, shouldFallbackForQuota } from "../services/quota.js";

/**
 * Handle System One request for the SSE/Next.js server.
 * Provider IS the model (`model` = "provider" or "provider/jev-latest").
 * Mirrors handleSearch auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleSystemOne(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SYSTEMONE", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  // Accept either `provider` or `model` (UI sends `model` since provider IS the model)
  const providerInput = body.provider || body.model;

  log.request("POST", `${url.pathname} | ${providerInput}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!providerInput || typeof providerInput !== "string") {
    log.warn("SYSTEMONE", "Missing provider/model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: model (or provider)");
  }

  if (!body.state || typeof body.state !== "object" || Array.isArray(body.state)) {
    log.warn("SYSTEMONE", "Missing state");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: state (object)");
  }

  if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    log.warn("SYSTEMONE", "Missing questions");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: questions (object)");
  }

  // Split optional per-request model: "provider" or "provider/jev-latest"
  const [providerPart, ...modelRest] = providerInput.split("/");
  const requestedModel = modelRest.join("/") || undefined;
  let providerId = resolveProviderId(providerPart);

  // Built-in System One providers first, then "System One Compatible" custom
  // nodes (matched by node id or user-chosen prefix). Connections live under
  // the node id, so the credential lookup below must target it.
  let resolvedProvider = AI_PROVIDERS[providerId];
  let providerConfig = resolvedProvider?.systemOneConfig || null;

  if (!resolvedProvider) {
    const nodes = await getProviderNodes({ type: "systemone-compatible" });
    const node = findSystemOneNode(nodes, providerId) || findSystemOneNode(nodes, providerPart);
    if (node) {
      const built = buildSystemOneNodeProvider(node);
      resolvedProvider = built.provider;
      providerConfig = built.providerConfig;
      providerId = node.id;
      if (providerPart !== node.id) {
        log.info("ROUTING", `${providerPart} → ${node.id}`);
      }
    }
  }

  if (!resolvedProvider) {
    log.warn("SYSTEMONE", "Unknown provider", { provider: providerPart });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerPart}`);
  }

  if (!providerConfig || !(resolvedProvider.serviceKinds ?? ["systemOne"]).includes("systemOne")) {
    log.warn("SYSTEMONE", "Provider does not support System One", { provider: providerId });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support System One`);
  }

  const model = requestedModel || providerConfig.defaultModel;

  if (providerInput !== `${providerId}${model ? `/${model}` : ""}`) {
    log.info("ROUTING", `${providerInput} → ${providerId}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${providerId}, Model: ${model}`);
  }

  // Sanitized body forwarded to core
  const coreBody = { ...body };
  delete coreBody.provider;
  coreBody.model = model;

  // Credential + fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // Lock scope: attribute error locks to systemone so a failing key never
  // takes the whole provider offline for other endpoints.
  const lockKey = `systemone:${providerId}`;

  while (true) {
    const credentials = await getProviderCredentials(providerId, excludeConnectionIds, lockKey);

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("SYSTEMONE", `[${providerId}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${providerId}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${providerId}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${providerId}`);
      }
      log.warn("SYSTEMONE", "No more accounts available", { provider: providerId });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(providerId, credentials);
    const quota = await enforceQuota({ apiKey, provider: providerId, connectionId: credentials.connectionId });
    if (!quota.allowed) {
      if (shouldFallbackForQuota(quota.violation)) {
        log.warn("QUOTA", `Account ${credentials.connectionName} quota exceeded, trying fallback`);
        excludeConnectionIds.add(credentials.connectionId);
        lastError = quota.violation?.rule?.description || "Provider account quota exceeded";
        lastStatus = HTTP_STATUS.RATE_LIMITED;
        continue;
      }
      log.warn("QUOTA", quota.violation?.rule?.description || "Quota exceeded");
      return quota.response;
    }

    const result = await handleSystemOneCore({
      body: coreBody,
      provider: resolvedProvider,
      providerConfig,
      credentials: refreshedCredentials,
      log
    });

    if (result.success) {
      await clearAccountError(credentials.connectionId, credentials);
      await recordSuccessfulUsage({
        provider: providerId,
        model,
        connectionId: credentials.connectionId,
        apiKey,
        endpoint: new URL(request.url).pathname,
        usage: result.data?.usage,
        meta: { source: "systemOne" },
      });
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, providerId, lockKey);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
