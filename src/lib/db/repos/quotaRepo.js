import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

export const QUOTA_SCOPE_TYPES = new Set(["global", "apiKey", "provider", "providerConnection"]);
export const QUOTA_PERIODS = new Set(["today", "24h", "7d", "30d"]);
export const QUOTA_METRICS = new Set(["requests", "promptTokens", "completionTokens", "totalTokens", "cost"]);

const PERIOD_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

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
    description: row.description || "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
    enabled: next.enabled === undefined ? true : !!next.enabled,
    description: String(next.description || "").trim(),
  };
}

function getPeriodWindow(period, now = new Date()) {
  if (period === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }

  const ms = PERIOD_MS[period];
  return {
    start: new Date(now.getTime() - ms),
    end: null,
    durationMs: ms,
  };
}

function buildUsageWhere(rule, apiKeyValue, now = new Date()) {
  const { start } = getPeriodWindow(rule.period, now);
  const where = ["timestamp >= ?"];
  const params = [start.toISOString()];

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

  return { where: where.join(" AND "), params };
}

function usageMetricValue(row, metric) {
  if (!row) return 0;
  if (metric === "totalTokens") return Number(row.promptTokens || 0) + Number(row.completionTokens || 0);
  return Number(row[metric] || 0);
}

function resetAtForPeriod(period, oldestTimestamp, now = new Date()) {
  const window = getPeriodWindow(period, now);
  if (period === "today") return window.end.toISOString();
  if (!oldestTimestamp) return null;
  return new Date(new Date(oldestTimestamp).getTime() + window.durationMs).toISOString();
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
    `INSERT INTO quotaRules(id, scopeType, scopeId, period, metric, limitValue, enabled, description, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rule.id, rule.scopeType, rule.scopeId, rule.period, rule.metric,
      rule.limitValue, rule.enabled ? 1 : 0, rule.description,
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
     SET scopeType = ?, scopeId = ?, period = ?, metric = ?, limitValue = ?, enabled = ?, description = ?, updatedAt = ?
     WHERE id = ?`,
    [
      updated.scopeType, updated.scopeId, updated.period, updated.metric,
      updated.limitValue, updated.enabled ? 1 : 0, updated.description,
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
  const where = buildUsageWhere(normalizedRule, apiKeyValue, options.now || new Date());
  if (!where) {
    return {
      used: 0,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cost: 0,
      resetAt: resetAtForPeriod(normalizedRule.period, null, options.now || new Date()),
    };
  }

  const row = db.get(
    `SELECT
       COUNT(*) AS requests,
       COALESCE(SUM(promptTokens), 0) AS promptTokens,
       COALESCE(SUM(completionTokens), 0) AS completionTokens,
       COALESCE(SUM(cost), 0) AS cost,
       MIN(timestamp) AS oldestTimestamp
     FROM usageHistory
     WHERE ${where.where}`,
    where.params,
  );

  const promptTokens = Number(row?.promptTokens || 0);
  const completionTokens = Number(row?.completionTokens || 0);
  const usage = {
    requests: Number(row?.requests || 0),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cost: Number(row?.cost || 0),
    resetAt: resetAtForPeriod(normalizedRule.period, row?.oldestTimestamp || null, options.now || new Date()),
  };
  usage.used = usageMetricValue(usage, normalizedRule.metric);
  return usage;
}

export async function getQuotaTargets() {
  const [apiKeys, connections] = await Promise.all([
    import("./apiKeysRepo.js").then((m) => m.getApiKeys()).catch(() => []),
    import("./connectionsRepo.js").then((m) => m.getProviderConnections()).catch(() => []),
  ]);
  const providers = [...new Set(connections.map((conn) => conn.provider).filter(Boolean))].sort();

  return {
    apiKeys: apiKeys.map((key) => ({ id: key.id, name: key.name || key.id, isActive: key.isActive })),
    providers: providers.map((id) => ({ id, name: id })),
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
