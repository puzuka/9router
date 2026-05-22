import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";
import { enforceQuota, recordSuccessfulUsage, shouldFallbackForQuota } from "../services/quota.js";

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleStt(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const modelStr = formData.get("model");
  const endpoint = new URL(request.url).pathname;
  log.request("POST", `${endpoint} | ${modelStr}`);

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!formData.get("file")) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const quota = await enforceQuota({ apiKey, provider });
    if (!quota.allowed) {
      log.warn("QUOTA", quota.violation?.rule?.description || "Quota exceeded");
      return quota.response;
    }

    const result = await handleSttCore({ provider, model, formData, sttConfig: AI_PROVIDERS[provider]?.sttConfig });
    if (result.success) {
      await recordSuccessfulUsage({
        provider,
        model,
        apiKey,
        endpoint,
        cost: 0,
        meta: { source: "stt" },
      });
      return result.response;
    }
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Credentialed — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);
    const quota = await enforceQuota({ apiKey, provider, connectionId: credentials.connectionId });
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

    const result = await handleSttCore({ provider, model, formData, credentials, sttConfig: AI_PROVIDERS[provider]?.sttConfig });

    if (result.success) {
      await recordSuccessfulUsage({
        provider,
        model,
        connectionId: credentials.connectionId,
        apiKey,
        endpoint,
        cost: 0,
        meta: { source: "stt" },
      });
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
