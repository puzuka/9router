import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

export const QUOTA_SCOPE_TYPES = new Set(["global", "apiKey", "provider", "providerConnection"]);
export const QUOTA_PERIODS = new Set(["today", "24h", "7d", "30d"]);
export const QUOTA_METRICS = new Set(["requests", "promptTokens", "completionTokens", "totalTokens", "cost"]);

const PERIOD_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function getTimezoneOffsetMinutes(options = {}) {
  const value = Number(options.tzOffsetMinutes);
  return Number.isFinite(value) ? value : new Date().getTimezoneOffset();
}

function getZonedDayStart(timestampMs, tzOffsetMinutes) {
  const offsetMs = tzOffsetMinutes * 60 * 1000;
  const shifted = timestampMs - offsetMs;
  const shiftedDate = new Date(shifted);
  return new Date(Date.UTC(shiftedDate.getUTCFullYear(), shiftedDate.getUTCMonth(), shiftedDate.getUTCDate()) + offsetMs);
}

function rowToRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    period: row.period,
    metric: row.metric,
    limitValue: Number(row.limitValue),
    enabled: row.enabled === 1 || row.enabled === true,
    models: normalizeModelFilter(parseJson(row.models, { mode: "all", include: [], exclude: [] })),
    description: row.description || "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeModelId(model) {
  return String(model || "").trim();
}

function normalizeModelList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(normalizeModelId)
    .filter(Boolean))];
}

function normalizeModelFilter(value = {}) {
  const mode = value.mode === "include" || value.mode === "exclude" ? value.mode : "all";
  return {
    mode,
    include: normalizeModelList(value.include),
    exclude: normalizeModelList(value.exclude),
  };
}

function modelMatchesRule(rule, model) {
  const filter = normalizeModelFilter(rule.models);
  if (filter.mode === "all") return true;
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel) return false;
  if (filter.mode === "include") return filter.include.includes(normalizedModel);
  return !filter.exclude.includes(normalizedModel);
}

function normalizeScopeId(scopeType, scopeId) {
  if (scopeType === "global") return "global";
  return String(scopeId || "").trim();
}

function normalizeRuleInput(input, existing = {}) {
  const next = { ...existing, ...input };
  const scopeType = String(next.scopeType || "").trim();
  const scopeId = normalizeScopeId(scopeType, next.scopeId);
  const period = String(next.period || "").trim();
  const metric = String(next.metric || "").trim();
  const limitValue = Number(next.limitValue);

  if (!QUOTA_SCOPE_TYPES.has(scopeType)) throw new Error("Invalid quota scope type");
  if (!scopeId) throw new Error("Quota scope is required");
  if (!QUOTA_PERIODS.has(period)) throw new Error("Invalid quota period");
  if (!QUOTA_METRICS.has(metric)) throw new Error("Invalid quota metric");
  if (!Number.isFinite(limitValue) || limitValue <= 0) throw new Error("Quota limit must be greater than 0");

  return {
    scopeType,
    scopeId,
    period,
    metric,
    limitValue,
    models: normalizeModelFilter(next.models),
    enabled: next.enabled === undefined ? true : !!next.enabled,
    description: String(next.description || "").trim(),
  };
}

function getPeriodWindow(period, now = new Date(), options = {}) {
  const tzOffsetMinutes = getTimezoneOffsetMinutes(options);
  const end = getZonedDayStart(now.getTime(), tzOffsetMinutes);
  end.setUTCDate(end.getUTCDate() + 1);

  const days = period === "7d" ? 7 : period === "30d" ? 30 : 1;
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - days);
  return { start, end, durationMs: PERIOD_MS[period] || PERIOD_MS["24h"] };
}

function buildUsageWhere(rule, apiKeyValue, now = new Date(), options = {}) {
  const { start, end } = getPeriodWindow(rule.period, now, options);
  const where = ["timestamp >= ?", "timestamp < ?"];
  const params = [start.toISOString(), end.toISOString()];

  if (rule.scopeType === "apiKey") {
    if (!apiKeyValue) return null;
    where.push("apiKey = ?");
    params.push(apiKeyValue);
  } else if (rule.scopeType === "provider") {
    where.push("provider = ?");
    params.push(rule.scopeId);
  } else if (rule.scopeType === "providerConnection") {
    where.push("connectionId = ?");
    params.push(rule.scopeId);
  }

  const filter = normalizeModelFilter(rule.models);
  if (filter.mode === "include") {
    if (filter.include.length === 0) return null;
    where.push(`model IN (${filter.include.map(() => "?").join(", ")})`);
    params.push(...filter.include);
  } else if (filter.mode === "exclude" && filter.exclude.length > 0) {
    where.push(`(model IS NULL OR model NOT IN (${filter.exclude.map(() => "?").join(", ")}))`);
    params.push(...filter.exclude);
  }

  return { where: where.join(" AND "), params };
}

function usageMetricValue(row, metric) {
  if (!row) return 0;
  return Number(row[metric] || 0);
}

function resetAtForPeriod(period, now = new Date(), options = {}) {
  return getPeriodWindow(period, now, options).end.toISOString();
}

async function getApiKeyValueForScope(rule) {
  if (rule.scopeType !== "apiKey") return null;
  const db = await getAdapter();
  const row = db.get(`SELECT key FROM apiKeys WHERE id = ?`, [rule.scopeId]);
  return row?.key || null;
}

export async function listQuotaRules(options = {}) {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM quotaRules ORDER BY scopeType ASC, scopeId ASC, period ASC, metric ASC`);
  const rules = rows.map(rowToRule);
  if (!options.includeUsage) return rules;

  const [apiKeys, connections] = await Promise.all([
    import("./apiKeysRepo.js").then((m) => m.getApiKeys()).catch(() => []),
    import("./connectionsRepo.js").then((m) => m.getProviderConnections()).catch(() => []),
  ]);
  const apiKeyById = new Map(apiKeys.map((key) => [key.id, key]));
  const connectionById = new Map(connections.map((conn) => [conn.id, conn]));

  return await Promise.all(rules.map(async (rule) => {
    const apiKey = apiKeyById.get(rule.scopeId);
    const connection = connectionById.get(rule.scopeId);
    const usage = await getQuotaUsage(rule, {
      apiKeyValue: apiKey?.key || null,
      tzOffsetMinutes: options.tzOffsetMinutes,
    });

    let scopeName = rule.scopeId;
    if (rule.scopeType === "global") scopeName = "All traffic";
    if (rule.scopeType === "apiKey") scopeName = apiKey?.name || rule.scopeId;
    if (rule.scopeType === "providerConnection") {
      const label = connection?.name || connection?.email || connection?.id || rule.scopeId;
      scopeName = connection?.provider ? `${connection.provider} / ${label}` : label;
    }

    return {
      ...rule,
      scopeName,
      usage,
      remaining: Math.max(0, rule.limitValue - usage.used),
      overLimit: usage.used >= rule.limitValue,
    };
  }));
}

export async function getQuotaRule(id) {
  const db = await getAdapter();
  return rowToRule(db.get(`SELECT * FROM quotaRules WHERE id = ?`, [id]));
}

export async function createQuotaRule(input) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const rule = {
    id: uuidv4(),
    ...normalizeRuleInput(input),
    createdAt: now,
    updatedAt: now,
  };

  db.run(
    `INSERT INTO quotaRules(id, scopeType, scopeId, period, metric, limitValue, enabled, models, description, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rule.id, rule.scopeType, rule.scopeId, rule.period, rule.metric,
      rule.limitValue, rule.enabled ? 1 : 0, stringifyJson(rule.models), rule.description,
      rule.createdAt, rule.updatedAt,
    ],
  );

  return rule;
}

export async function updateQuotaRule(id, input) {
  const db = await getAdapter();
  const existing = await getQuotaRule(id);
  if (!existing) return null;
  const merged = normalizeRuleInput(input, existing);
  const updated = { ...existing, ...merged, updatedAt: new Date().toISOString() };

  db.run(
    `UPDATE quotaRules
     SET scopeType = ?, scopeId = ?, period = ?, metric = ?, limitValue = ?, enabled = ?, models = ?, description = ?, updatedAt = ?
     WHERE id = ?`,
    [
      updated.scopeType, updated.scopeId, updated.period, updated.metric,
      updated.limitValue, updated.enabled ? 1 : 0, stringifyJson(updated.models), updated.description,
      updated.updatedAt, id,
    ],
  );

  return updated;
}

export async function deleteQuotaRule(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM quotaRules WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function getQuotaUsage(rule, options = {}) {
  const normalizedRule = rowToRule(rule) || rule;
  const apiKeyValue = options.apiKeyValue ?? await getApiKeyValueForScope(normalizedRule);
  const db = await getAdapter();
  const now = options.now || new Date();
  const where = buildUsageWhere(normalizedRule, apiKeyValue, now, options);
  if (!where) {
    return {
      used: 0,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cost: 0,
      resetAt: resetAtForPeriod(normalizedRule.period, now, options),
    };
  }

  const rows = db.all(
    `SELECT promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE ${where.where}`,
    where.params,
  );

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cost = 0;
  for (const row of rows) {
    const tokens = (() => { try { return row.tokens ? JSON.parse(row.tokens) : {}; } catch { return {}; } })();
    const prompt = Number(row.promptTokens ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0) || 0;
    const completion = Number(row.completionTokens ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0) || 0;
    const rawTotal = Number(tokens.total_tokens ?? tokens.totalTokenCount ?? 0) || 0;
    promptTokens += prompt;
    completionTokens += completion;
    totalTokens += rawTotal > 0 ? rawTotal : prompt + completion;
    cost += Number(row.cost || 0);
  }

  const usage = {
    requests: rows.length,
    promptTokens,
    completionTokens,
    totalTokens,
    cost,
    resetAt: resetAtForPeriod(normalizedRule.period, now, options),
  };
  usage.used = usageMetricValue(usage, normalizedRule.metric);
  return usage;
}

export async function getQuotaTargets() {
  const [apiKeys, connections, pricing] = await Promise.all([
    import("./apiKeysRepo.js").then((m) => m.getApiKeys()).catch(() => []),
    import("./connectionsRepo.js").then((m) => m.getProviderConnections()).catch(() => []),
    import("./pricingRepo.js").then((m) => m.getPricing()).catch(() => ({})),
  ]);
  const providers = [...new Set(connections.map((conn) => conn.provider).filter(Boolean))].sort();
  const modelSet = new Set();
  for (const [provider, models] of Object.entries(pricing || {})) {
    for (const model of Object.keys(models || {})) modelSet.add(model);
  }

  return {
    apiKeys: apiKeys.map((key) => ({ id: key.id, name: key.name || key.id, isActive: key.isActive })),
    providers: providers.map((id) => ({ id, name: id })),
    models: [...modelSet].sort().map((id) => ({ id, name: id })),
    providerConnections: connections.map((conn) => ({
      id: conn.id,
      provider: conn.provider,
      name: conn.name || conn.email || conn.id,
      isActive: conn.isActive,
    })),
  };
}

export async function checkQuota(context = {}) {
  const db = await getAdapter();
  const apiKeyRow = context.apiKey
    ? await import("./apiKeysRepo.js").then((m) => m.getApiKeyByKey(context.apiKey)).catch(() => null)
    : null;

  const params = [
    context.provider || "",
    context.connectionId || "",
    apiKeyRow?.id || "",
  ];
  const rows = db.all(
    `SELECT * FROM quotaRules
     WHERE enabled = 1
       AND (
         scopeType = 'global'
         OR (scopeType = 'provider' AND scopeId = ?)
         OR (scopeType = 'providerConnection' AND scopeId = ?)
         OR (scopeType = 'apiKey' AND scopeId = ?)
       )`,
    params,
  );

  for (const row of rows) {
    const rule = rowToRule(row);
    if (!modelMatchesRule(rule, context.model)) continue;
    const usage = await getQuotaUsage(rule, {
      apiKeyValue: rule.scopeType === "apiKey" ? context.apiKey : null,
    });
    if (usage.used >= rule.limitValue) {
      return {
        allowed: false,
        violation: {
          rule,
          usage,
          used: usage.used,
          limitValue: rule.limitValue,
          resetAt: usage.resetAt,
        },
      };
    }
  }

  return { allowed: true, checks: rows.map(rowToRule) };
}
