import { v4 as uuidv4 } from "uuid";
import { checkQuota } from "@/lib/localDb";
import { saveRequestUsage } from "@/lib/usageDb.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

function formatMetric(metric) {
  return {
    requests: "requests",
    promptTokens: "input tokens",
    completionTokens: "output tokens",
    totalTokens: "tokens",
    cost: "cost",
  }[metric] || metric;
}

function formatScope(rule) {
  if (rule.scopeType === "global") return "all traffic";
  if (rule.scopeType === "apiKey") return "API key";
  if (rule.scopeType === "provider") return `provider ${rule.scopeId}`;
  if (rule.scopeType === "providerConnection") return "provider account";
  return rule.scopeType;
}

export function quotaExceededResponse(violation) {
  const { rule, used, limitValue, resetAt } = violation;
  const resetSuffix = resetAt ? ` Resets at ${resetAt}.` : "";
  const message = `Quota exceeded for ${formatScope(rule)}: ${used}/${limitValue} ${formatMetric(rule.metric)} in ${rule.period}.${resetSuffix}`;
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (resetAt) {
    const retryAfterSec = Math.max(Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000), 1);
    headers["Retry-After"] = String(retryAfterSec);
  }

  return new Response(JSON.stringify({
    error: {
      message,
      type: "rate_limit_error",
      code: "quota_exceeded",
      quota: {
        scopeType: rule.scopeType,
        scopeId: rule.scopeId,
        period: rule.period,
        metric: rule.metric,
        used,
        limit: limitValue,
        resetAt,
      },
    },
  }), {
    status: HTTP_STATUS.RATE_LIMITED,
    headers,
  });
}

export async function enforceQuota(context) {
  const result = await checkQuota(context);
  if (result.allowed) return { allowed: true };
  return {
    allowed: false,
    violation: result.violation,
    response: quotaExceededResponse(result.violation),
  };
}

export function shouldFallbackForQuota(violation) {
  return violation?.rule?.scopeType === "providerConnection";
}

export function createQuotaContext(requestedModel, fields = {}, comboName = "") {
  const normalizedComboName = comboName ? String(comboName) : null;
  if (!requestedModel && !normalizedComboName) return { ...fields };
  return {
    ...fields,
    requestedModel: requestedModel ? String(requestedModel) : undefined,
    comboName: normalizedComboName,
    quotaRequestId: fields.quotaRequestId || uuidv4(),
  };
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeUsageTokens(usage = {}) {
  const queryCount =
    numberOrNull(usage.queries_used) ??
    numberOrNull(usage.requests_used) ??
    numberOrNull(usage.request_count) ??
    null;
  const promptTokens =
    numberOrNull(usage.prompt_tokens) ??
    numberOrNull(usage.input_tokens) ??
    numberOrNull(usage.promptTokenCount) ??
    numberOrNull(usage.inputTokenCount) ??
    null;
  const completionTokens =
    numberOrNull(usage.completion_tokens) ??
    numberOrNull(usage.output_tokens) ??
    numberOrNull(usage.candidatesTokenCount) ??
    numberOrNull(usage.outputTokenCount) ??
    null;
  const totalTokens =
    numberOrNull(usage.total_tokens) ??
    numberOrNull(usage.totalTokenCount) ??
    numberOrNull(usage.llm_tokens) ??
    null;

  const normalizedPrompt = promptTokens ?? (completionTokens == null ? totalTokens ?? queryCount ?? 0 : 0);
  const normalizedCompletion = completionTokens ?? 0;

  if (normalizedPrompt === 0 && normalizedCompletion === 0) {
    return { prompt_tokens: 1, completion_tokens: 0 };
  }

  return {
    prompt_tokens: normalizedPrompt,
    completion_tokens: normalizedCompletion,
  };
}

function normalizeUsageCost(usage = {}) {
  return (
    numberOrNull(usage.cost) ??
    numberOrNull(usage.cost_usd) ??
    numberOrNull(usage.search_cost_usd) ??
    numberOrNull(usage.fetch_cost_usd)
  );
}

export async function recordSuccessfulUsage({
  provider,
  model,
  connectionId,
  apiKey,
  endpoint,
  usage,
  tokens,
  cost,
  requestedModel,
  comboName,
  quotaRequestId,
  meta = {},
}) {
  const usageData = usage && typeof usage === "object" ? usage : {};
  await saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    status: "ok",
    tokens: tokens && typeof tokens === "object" ? tokens : normalizeUsageTokens(usageData),
    cost: numberOrNull(cost) ?? normalizeUsageCost(usageData) ?? undefined,
    requestedModel: requestedModel || undefined,
    comboName: comboName || undefined,
    quotaRequestId: quotaRequestId || undefined,
    meta,
  });
}
