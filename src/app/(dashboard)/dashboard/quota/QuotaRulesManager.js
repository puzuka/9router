"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, ConfirmModal, Input, Modal, Select, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const SCOPE_OPTIONS = [
  { value: "provider", label: "Provider" },
  { value: "providerConnection", label: "Provider account" },
  { value: "apiKey", label: "API key" },
  { value: "global", label: "Global" },
];

const PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
];

const METRIC_OPTIONS = [
  { value: "requests", label: "Requests" },
  { value: "promptTokens", label: "Input tokens" },
  { value: "completionTokens", label: "Output tokens" },
  { value: "totalTokens", label: "Total tokens" },
  { value: "cost", label: "Cost" },
];

const MODEL_MODE_OPTIONS = [
  { value: "all", label: "All models and combos" },
  { value: "include", label: "Only selected models or combos" },
  { value: "exclude", label: "All except selected models or combos" },
];

const EMPTY_TARGETS = { apiKeys: [], providers: [], providerConnections: [], models: [], combos: [] };
const EMPTY_MODELS = { mode: "all", include: [], exclude: [], includeCombos: [], excludeCombos: [] };

function emptyForm() {
  return {
    scopeType: "provider",
    scopeId: "",
    period: "24h",
    metric: "requests",
    limitValue: "100",
    models: { ...EMPTY_MODELS, include: [], exclude: [], includeCombos: [], excludeCombos: [] },
    description: "",
    enabled: true,
  };
}

function formatNumber(value, metric) {
  const num = Number(value || 0);
  if (metric === "cost") {
    return `$${num.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
  }
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDateTime(value) {
  if (!value) return "Rolling";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Rolling";
  return date.toLocaleString();
}

function getMetricLabel(metric) {
  return METRIC_OPTIONS.find((item) => item.value === metric)?.label || metric;
}

function getScopeLabel(scopeType) {
  return SCOPE_OPTIONS.find((item) => item.value === scopeType)?.label || scopeType;
}

function getPeriodLabel(period) {
  return PERIOD_OPTIONS.find((item) => item.value === period)?.label || period;
}

function getTargetOptions(scopeType, targets) {
  if (scopeType === "global") return [{ value: "global", label: "All traffic" }];
  if (scopeType === "apiKey") {
    return (targets.apiKeys || []).map((key) => ({
      value: key.id,
      label: `${key.name || key.id}${key.isActive === false ? " (inactive)" : ""}`,
    }));
  }
  if (scopeType === "providerConnection") {
    return (targets.providerConnections || []).map((connection) => ({
      value: connection.id,
      label: `${connection.provider} / ${connection.name || connection.id}${connection.isActive === false ? " (inactive)" : ""}`,
    }));
  }
  return (targets.providers || []).map((provider) => ({ value: provider.id, label: provider.name || provider.id }));
}

function getModelOptions(targets) {
  const models = (targets.models || []).map((model) => ({
    key: `model:${model.id}`,
    value: model.id,
    type: "model",
    label: model.name || model.id,
    providers: Array.isArray(model.providers) ? model.providers : [],
  }));
  const combos = (targets.combos || []).map((combo) => ({
    key: `combo:${combo.id || combo.name}`,
    value: combo.id || combo.name,
    type: "combo",
    label: combo.name || combo.id,
    kind: combo.kind || "llm",
    memberCount: Array.isArray(combo.models) ? combo.models.length : 0,
    providers: [],
  }));
  return [...combos, ...models].sort((a, b) => a.value.localeCompare(b.value));
}

function getModelListForMode(models) {
  if (models.mode === "include") return [
    ...(models.include || []).map((value) => ({ key: `model:${value}`, value, type: "model" })),
    ...(models.includeCombos || []).map((value) => ({ key: `combo:${value}`, value, type: "combo" })),
  ];
  if (models.mode === "exclude") return [
    ...(models.exclude || []).map((value) => ({ key: `model:${value}`, value, type: "model" })),
    ...(models.excludeCombos || []).map((value) => ({ key: `combo:${value}`, value, type: "combo" })),
  ];
  return [];
}

function setModelListForMode(models, list) {
  const modelValues = list.filter((item) => item.type === "model").map((item) => item.value);
  const comboValues = list.filter((item) => item.type === "combo").map((item) => item.value);
  if (models.mode === "include") return { ...models, include: modelValues, includeCombos: comboValues };
  if (models.mode === "exclude") return { ...models, exclude: modelValues, excludeCombos: comboValues };
  return models;
}

function toggleModel(models, option) {
  const list = getModelListForMode(models);
  const next = list.some((item) => item.key === option.key)
    ? list.filter((item) => item.key !== option.key)
    : [...list, { key: option.key, value: option.value, type: option.type }];
  return setModelListForMode(models, next);
}

function summarizeModels(models) {
  if (!models || models.mode === "all") return "All models and combos";
  const list = getModelListForMode(models);
  if (models.mode === "include") return list.length ? `${list.length} selected` : "No models or combos selected";
  return list.length ? `All except ${list.length}` : "All models and combos";
}

function SelectedModelChips({ models, modelOptionMap, limit = Infinity, onRemove, className = "" }) {
  const selected = getModelListForMode(models);
  if (selected.length === 0) return null;

  const visible = selected.slice(0, limit);
  const hiddenCount = selected.length - visible.length;

  return (
    <div className={`flex min-w-0 flex-wrap gap-1.5 ${className}`}>
      {visible.map((model) => {
        const option = modelOptionMap?.get(model.key);
        const label = option?.label && option.label !== model.value ? option.label : "";
        const providerText = option?.providers?.length ? option.providers.join(", ") : "";
        const typeLabel = model.type === "combo" ? "Combo" : "Model";
        const title = [typeLabel, model.value, label, providerText].filter(Boolean).join(" / ");

        return (
          <span
            key={model.key}
            title={title}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-main"
          >
            {model.type === "combo" && (
              <span aria-hidden="true" className="material-symbols-outlined text-[13px] text-primary">layers</span>
            )}
            <span className="max-w-[180px] truncate font-mono">{model.value}</span>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(model)}
                aria-label={`Remove ${model.value}`}
                className="-mr-1 flex size-4 items-center justify-center rounded-full text-text-muted hover:bg-surface hover:text-text-main"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[13px]">close</span>
              </button>
            )}
          </span>
        );
      })}
      {hiddenCount > 0 && (
        <span className="inline-flex items-center rounded-full border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-muted">
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}

function normalizeForm(rule) {
  if (!rule) return emptyForm();
  return {
    scopeType: rule.scopeType || "provider",
    scopeId: rule.scopeId || "",
    period: rule.period || "24h",
    metric: rule.metric || "requests",
    limitValue: String(rule.limitValue || ""),
    models: {
      mode: rule.models?.mode || "all",
      include: Array.isArray(rule.models?.include) ? rule.models.include : [],
      exclude: Array.isArray(rule.models?.exclude) ? rule.models.exclude : [],
      includeCombos: Array.isArray(rule.models?.includeCombos) ? rule.models.includeCombos : [],
      excludeCombos: Array.isArray(rule.models?.excludeCombos) ? rule.models.excludeCombos : [],
    },
    description: rule.description || "",
    enabled: rule.enabled !== false,
  };
}

function buildPayload(form) {
  return {
    scopeType: form.scopeType,
    scopeId: form.scopeType === "global" ? "global" : form.scopeId,
    period: form.period,
    metric: form.metric,
    limitValue: Number(form.limitValue),
    models: form.models,
    description: form.description.trim(),
    enabled: form.enabled,
  };
}

function getRuleState(rule) {
  if (!rule.enabled) return { label: "Paused", variant: "default", icon: "pause_circle" };
  if (rule.overLimit) return { label: "Blocked", variant: "error", icon: "block" };
  const percent = Number(rule.limitValue) > 0 ? (Number(rule.usage?.used || 0) / Number(rule.limitValue)) * 100 : 0;
  if (percent >= 80) return { label: "Near limit", variant: "warning", icon: "warning" };
  return { label: "Active", variant: "success", icon: "check_circle" };
}

function UsageBar({ rule }) {
  const used = Number(rule.usage?.used || 0);
  const limit = Number(rule.limitValue || 0);
  const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const remaining = Math.max(0, limit - used);
  const remainingPercent = limit > 0 ? Math.max(0, 100 - percent) : 0;
  const color = rule.overLimit ? "bg-red-500" : percent >= 80 ? "bg-yellow-500" : "bg-brand-500";

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-text-main">
          {formatNumber(used, rule.metric)} / {formatNumber(limit, rule.metric)}
        </span>
        <span className="text-text-muted">{Math.round(percent)}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label={`${getMetricLabel(rule.metric)} quota usage`}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
      >
        <div className={`h-full rounded-full ${color}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-text-muted">
        <span>{formatNumber(remaining, rule.metric)} remaining</span>
        <span>{Math.round(remainingPercent)}% left</span>
      </div>
    </div>
  );
}

function QuotaRuleModal({ isOpen, onClose, onSave, rule, targets, saving }) {
  const [form, setForm] = useState(normalizeForm(rule));
  const [modelSearch, setModelSearch] = useState("");
  const targetOptions = useMemo(() => getTargetOptions(form.scopeType, targets), [form.scopeType, targets]);
  const modelOptions = useMemo(() => getModelOptions(targets), [targets]);
  const modelOptionMap = useMemo(() => new Map(modelOptions.map((model) => [model.key, model])), [modelOptions]);
  const filteredModelOptions = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return modelOptions;
    return modelOptions.filter((model) => {
      const providerText = model.providers.join(" ");
      return `${model.value} ${model.label} ${providerText}`.toLowerCase().includes(query);
    });
  }, [modelOptions, modelSearch]);
  const isEdit = !!rule;
  const selectedModels = getModelListForMode(form.models);
  const selectedModelSet = useMemo(() => new Set(selectedModels.map((model) => model.key)), [selectedModels]);
  const modelSelectionValid = form.models.mode !== "include" || selectedModels.length > 0;
  const canSave = (form.scopeType === "global" || form.scopeId) && Number(form.limitValue) > 0 && modelSelectionValid;

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  const setScopeType = (scopeType) => {
    setForm((prev) => ({
      ...prev,
      scopeType,
      scopeId: scopeType === "global" ? "global" : "",
    }));
  };
  const setModelMode = (mode) => {
    setField("models", { ...form.models, mode });
    setModelSearch("");
  };
  const setSelectedModels = (list) => {
    const deduped = [...new Map(list.map((item) => [item.key, item])).values()];
    setField("models", setModelListForMode(form.models, deduped));
  };
  const selectVisibleModels = () => {
    setSelectedModels([...selectedModels, ...filteredModelOptions]);
  };
  const clearSelectedModels = () => {
    setSelectedModels([]);
  };

  const handleSave = () => {
    if (!canSave) return;
    onSave(buildPayload(form));
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? "Edit quota rule" : "Create quota rule"}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button icon="save" onClick={handleSave} loading={saving} disabled={!canSave}>
            {isEdit ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Scope"
          value={form.scopeType}
          onChange={(event) => setScopeType(event.target.value)}
          options={SCOPE_OPTIONS}
          placeholder="Select scope"
        />
        <Select
          label="Target"
          value={form.scopeType === "global" ? "global" : form.scopeId}
          onChange={(event) => setField("scopeId", event.target.value)}
          options={targetOptions}
          placeholder={targetOptions.length ? "Select target" : "No targets"}
          disabled={form.scopeType === "global" || targetOptions.length === 0}
        />
        <Select
          label="Window"
          value={form.period}
          onChange={(event) => setField("period", event.target.value)}
          options={PERIOD_OPTIONS}
          placeholder="Select window"
        />
        <Select
          label="Metric"
          value={form.metric}
          onChange={(event) => setField("metric", event.target.value)}
          options={METRIC_OPTIONS}
          placeholder="Select metric"
        />
        <Input
          label="Limit"
          type="number"
          min="0"
          step={form.metric === "cost" ? "0.000001" : "1"}
          value={form.limitValue}
          onChange={(event) => setField("limitValue", event.target.value)}
          placeholder="100"
          required
        />
        <div className="flex items-end pb-2">
          <Toggle
            ariaLabel="Enable quota rule"
            checked={form.enabled}
            onChange={(enabled) => setField("enabled", enabled)}
            label="Enabled"
          />
        </div>
        <Input
          className="sm:col-span-2"
          label="Label"
          value={form.description}
          onChange={(event) => setField("description", event.target.value)}
          placeholder="Team daily token cap"
        />
        <div className="sm:col-span-2 rounded-lg border border-border bg-surface/60 p-3">
          <Select
            label="Models & Combos"
            value={form.models.mode}
            onChange={(event) => setModelMode(event.target.value)}
            options={MODEL_MODE_OPTIONS}
            placeholder="Select model mode"
          />
          {form.models.mode !== "all" && (
            <div className="mt-3 rounded border border-border bg-bg">
              <div className="border-b border-border-subtle p-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative min-w-0 flex-1">
                    <span aria-hidden="true" className="material-symbols-outlined pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[16px] text-text-muted">search</span>
                    <input
                      type="search"
                      aria-label="Search models and combos"
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder="Search model or combo"
                      className="w-full rounded-[8px] border border-transparent bg-surface-2 py-2 pl-8 pr-3 text-[16px] text-text-main placeholder-text-muted/70 focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30 sm:text-sm"
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={selectVisibleModels}
                      disabled={filteredModelOptions.length === 0}
                      className="rounded-[8px] px-2.5 py-2 text-xs font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Select visible
                    </button>
                    <button
                      type="button"
                      onClick={clearSelectedModels}
                      disabled={selectedModels.length === 0}
                      className="rounded-[8px] px-2.5 py-2 text-xs font-medium text-text-muted hover:bg-surface-2 hover:text-text-main disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-text-muted">
                  {selectedModels.length} selected / {filteredModelOptions.length} shown / {modelOptions.length} available
                  {form.models.mode === "include" && selectedModels.length === 0 ? " — select at least one model or combo" : ""}
                </p>
                <SelectedModelChips
                  models={form.models}
                  modelOptionMap={modelOptionMap}
                  onRemove={(model) => setField("models", toggleModel(form.models, model))}
                  className="mt-2 max-h-20 overflow-y-auto pr-1"
                />
              </div>
              <div className="max-h-56 overflow-y-auto p-2">
                {modelOptions.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-text-muted">No model or combo list available.</p>
                ) : filteredModelOptions.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-text-muted">No models or combos match this search.</p>
                ) : filteredModelOptions.map((option) => {
                  const providerText = option.providers.length ? option.providers.join(", ") : "";
                  const typeText = option.type === "combo"
                    ? `Combo · ${option.memberCount} ${option.memberCount === 1 ? "model" : "models"}`
                    : "Model";
                  return (
                    <label key={option.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-2">
                      <input
                        type="checkbox"
                        checked={selectedModelSet.has(option.key)}
                        onChange={() => setField("models", toggleModel(form.models, option))}
                        className="size-4 accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          {option.type === "combo" && (
                            <span className="material-symbols-outlined shrink-0 text-[14px] text-primary" aria-hidden="true">layers</span>
                          )}
                          <span className="block truncate font-mono text-xs text-text-main">{option.value}</span>
                        </span>
                        <span className="block truncate text-[11px] text-text-muted">
                          {[typeText, option.label !== option.value ? option.label : "", providerText].filter(Boolean).join(" / ")}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-text-muted">
            {form.models.mode === "include" ? "This rule only counts selected models and combo requests." : form.models.mode === "exclude" ? "This rule counts all traffic except selected models and combo requests." : "This rule counts every model and combo request."}
          </p>
        </div>
      </div>
    </Modal>
  );
}

function RuleRow({ rule, modelOptionMap, onEdit, onDelete, onToggle }) {
  const state = getRuleState(rule);

  return (
    <div className="grid gap-4 border-b border-border-subtle px-4 py-4 last:border-b-0 lg:grid-cols-[minmax(190px,1.1fr)_minmax(220px,1.3fr)_minmax(160px,0.8fr)_minmax(220px,1.2fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <Badge variant={state.variant} size="sm" icon={state.icon}>{state.label}</Badge>
          <Badge variant="default" size="sm">{getScopeLabel(rule.scopeType)}</Badge>
        </div>
        <p className="truncate text-sm font-semibold text-text-main">{rule.description || rule.scopeName || rule.scopeId}</p>
        <p className="truncate text-xs text-text-muted">{rule.scopeName || rule.scopeId}</p>
        <p className="truncate text-xs text-text-muted">Models &amp; Combos: {summarizeModels(rule.models)}</p>
        <SelectedModelChips models={rule.models} modelOptionMap={modelOptionMap} limit={3} className="mt-2" />
      </div>

      <UsageBar rule={rule} />

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-1">
        <div>
          <p className="text-text-muted">Metric</p>
          <p className="font-medium text-text-main">{getMetricLabel(rule.metric)}</p>
        </div>
        <div>
          <p className="text-text-muted">Window</p>
          <p className="font-medium text-text-main">{getPeriodLabel(rule.period)}</p>
        </div>
        <div>
          <p className="text-text-muted">Reset</p>
          <p className="font-medium text-text-main">{formatDateTime(rule.usage?.resetAt)}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-[10px] bg-surface-2 p-3 text-xs">
        <div>
          <p className="text-text-muted">Requests</p>
          <p className="font-semibold text-text-main">{formatNumber(rule.usage?.requests, "requests")}</p>
        </div>
        <div>
          <p className="text-text-muted">Tokens</p>
          <p className="font-semibold text-text-main">{formatNumber(rule.usage?.totalTokens, "totalTokens")}</p>
        </div>
        <div>
          <p className="text-text-muted">Cost</p>
          <p className="font-semibold text-text-main">{formatNumber(rule.usage?.cost, "cost")}</p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Toggle
          size="sm"
          ariaLabel={`${rule.enabled ? "Disable" : "Enable"} quota rule ${rule.description || rule.scopeName || rule.id}`}
          checked={rule.enabled}
          onChange={(enabled) => onToggle(rule, enabled)}
        />
        <button
          type="button"
          onClick={() => onEdit(rule)}
          aria-label={`Edit quota rule ${rule.description || rule.scopeName || rule.id}`}
          title="Edit"
          className="flex size-8 items-center justify-center rounded-[8px] text-text-muted hover:bg-surface-2 hover:text-text-main"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">edit</span>
        </button>
        <button
          type="button"
          onClick={() => onDelete(rule)}
          aria-label={`Delete quota rule ${rule.description || rule.scopeName || rule.id}`}
          title="Delete"
          className="flex size-8 items-center justify-center rounded-[8px] text-text-muted hover:bg-red-500/10 hover:text-red-500"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">delete</span>
        </button>
      </div>
    </div>
  );
}

export default function QuotaRulesManager() {
  const [rules, setRules] = useState([]);
  const [targets, setTargets] = useState(EMPTY_TARGETS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [confirmRule, setConfirmRule] = useState(null);
  const notify = useNotificationStore();
  const modelOptionMap = useMemo(() => {
    const options = getModelOptions(targets);
    return new Map(options.map((model) => [model.key, model]));
  }, [targets]);

  const fetchRules = useCallback(async () => {
    try {
      const response = await fetch("/api/quota/rules", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to fetch quota rules");
      setRules(data.rules || []);
      setTargets(data.targets || EMPTY_TARGETS);
    } catch (error) {
      notify.error(error.message || "Failed to fetch quota rules");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- quota rules load from the dashboard API after mount.
    fetchRules();
  }, [fetchRules]);

  const stats = useMemo(() => {
    const active = rules.filter((rule) => rule.enabled);
    const blocked = active.filter((rule) => rule.overLimit);
    const warning = active.filter((rule) => {
      const used = Number(rule.usage?.used || 0);
      const limit = Number(rule.limitValue || 0);
      return !rule.overLimit && limit > 0 && used / limit >= 0.8;
    });
    const usageTotal = rules.reduce((sum, rule) => sum + Number(rule.usage?.requests || 0), 0);
    return { active: active.length, blocked: blocked.length, warning: warning.length, usageTotal };
  }, [rules]);

  const openCreate = () => {
    setEditingRule(null);
    setShowModal(true);
  };

  const openEdit = (rule) => {
    setEditingRule(rule);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingRule(null);
  };

  const saveRule = async (payload) => {
    setSaving(true);
    try {
      const isEdit = !!editingRule;
      const response = await fetch(isEdit ? `/api/quota/rules/${editingRule.id}` : "/api/quota/rules", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save quota rule");
      await fetchRules();
      closeModal();
      notify.success(isEdit ? "Quota rule updated" : "Quota rule created");
    } catch (error) {
      notify.error(error.message || "Failed to save quota rule");
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (rule, enabled) => {
    setRules((prev) => prev.map((item) => item.id === rule.id ? { ...item, enabled } : item));
    try {
      const response = await fetch(`/api/quota/rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to update quota rule");
      await fetchRules();
    } catch (error) {
      await fetchRules();
      notify.error(error.message || "Failed to update quota rule");
    }
  };

  const deleteRule = async () => {
    if (!confirmRule) return;
    const rule = confirmRule;
    setConfirmRule(null);
    try {
      const response = await fetch(`/api/quota/rules/${rule.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to delete quota rule");
      setRules((prev) => prev.filter((item) => item.id !== rule.id));
      notify.success("Quota rule deleted");
    } catch (error) {
      notify.error(error.message || "Failed to delete quota rule");
    }
  };

  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-4">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex gap-2">
          <Button variant="secondary" icon="refresh" onClick={fetchRules}>Refresh</Button>
          <Button icon="add" onClick={openCreate}>Create Rule</Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card padding="sm">
          <p className="text-xs font-medium uppercase text-text-muted">Rules</p>
          <p className="mt-2 text-2xl font-semibold text-text-main">{rules.length}</p>
          <p className="text-xs text-text-muted">{stats.active} active</p>
        </Card>
        <Card padding="sm">
          <p className="text-xs font-medium uppercase text-text-muted">Blocked</p>
          <p className="mt-2 text-2xl font-semibold text-red-500">{stats.blocked}</p>
          <p className="text-xs text-text-muted">over limit now</p>
        </Card>
        <Card padding="sm">
          <p className="text-xs font-medium uppercase text-text-muted">Near Limit</p>
          <p className="mt-2 text-2xl font-semibold text-yellow-500">{stats.warning}</p>
          <p className="text-xs text-text-muted">above 80%</p>
        </Card>
        <Card padding="sm">
          <p className="text-xs font-medium uppercase text-text-muted">Counted Requests</p>
          <p className="mt-2 text-2xl font-semibold text-text-main">{formatNumber(stats.usageTotal, "requests")}</p>
          <p className="text-xs text-text-muted">visible in rules</p>
        </Card>
      </div>

      <Card padding="none" className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div>
            <h3 className="font-semibold text-text-main">Rules & usage</h3>
            <p className="text-xs text-text-muted">Current window values refresh from stored usage history.</p>
          </div>
          <Badge variant="info" size="sm" icon="data_usage">{rules.length} total</Badge>
        </div>

        {rules.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
            <div className="mb-4 flex size-14 items-center justify-center rounded-[14px] bg-surface-2 text-text-muted">
              <span className="material-symbols-outlined text-[30px]">rule</span>
            </div>
            <p className="font-medium text-text-main">No quota rules</p>
            <p className="mt-1 text-sm text-text-muted">Create a rule to see live usage against a limit.</p>
            <Button className="mt-4" icon="add" onClick={openCreate}>Create Rule</Button>
          </div>
        ) : (
          <div>
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                modelOptionMap={modelOptionMap}
                onEdit={openEdit}
                onDelete={setConfirmRule}
                onToggle={toggleRule}
              />
            ))}
          </div>
        )}
      </Card>

      {showModal && (
        <QuotaRuleModal
          key={editingRule?.id || "create"}
          isOpen={showModal}
          onClose={closeModal}
          onSave={saveRule}
          rule={editingRule}
          targets={targets}
          saving={saving}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmRule}
        onClose={() => setConfirmRule(null)}
        onConfirm={deleteRule}
        title="Delete quota rule"
        message={`Delete "${confirmRule?.description || confirmRule?.scopeName || "this rule"}"?`}
        confirmText="Delete"
        variant="danger"
      />
    </div>
  );
}
