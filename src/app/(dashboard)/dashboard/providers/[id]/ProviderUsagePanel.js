"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import SegmentedControl from "@/shared/components/SegmentedControl";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
];

const EMPTY_PROVIDER = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cost: 0,
  accountCount: 0,
  errorRequests: 0,
  lastStatus: "ok",
  lastUsed: null,
  accounts: [],
};

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

function fmtTime(iso) {
  if (!iso) return "Never";
  const diffMins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function getStatusMeta(statusCounts = {}, lastStatus = "ok") {
  const ok = Object.entries(statusCounts)
    .filter(([status]) => ["ok", "success", "done"].includes(String(status || "").toLowerCase()))
    .reduce((sum, [, count]) => sum + count, 0);
  const bad = Object.entries(statusCounts)
    .filter(([status]) => {
      const normalized = String(status || "").toLowerCase();
      return normalized && !["ok", "success", "done"].includes(normalized);
    })
    .reduce((sum, [, count]) => sum + count, 0);

  if (bad > 0 && ok > 0) return { label: "Mixed", variant: "warning" };
  if (bad > 0) return { label: lastStatus || "Error", variant: "error" };
  return { label: lastStatus || "OK", variant: "success" };
}

function ProviderMark({ providerId, providerInfo }) {
  const [failedProviderId, setFailedProviderId] = useState("");
  const imgError = failedProviderId === providerId;
  const color = providerInfo?.color;
  const label = providerInfo?.name || providerId;

  return (
    <div
      className="flex size-11 shrink-0 items-center justify-center rounded-[10px] border"
      style={{ borderColor: color ? `${color}40` : "var(--color-border)", backgroundColor: color ? `${color}14` : "var(--color-bg)" }}
    >
      {!imgError ? (
        <Image
          src={`/providers/${providerId}.png`}
          alt={label}
          width={26}
          height={26}
          className="size-6 object-contain"
          onError={() => setFailedProviderId(providerId)}
        />
      ) : (
        <span className="text-sm font-semibold" style={{ color: color || "var(--color-text-muted)" }}>
          {(providerInfo?.textIcon || label || "?").slice(0, 2).toUpperCase()}
        </span>
      )}
    </div>
  );
}

function MetricTile({ label, value, tone = "default" }) {
  const toneClass = {
    default: "text-text-main",
    primary: "text-primary",
    success: "text-success",
    warning: "text-warning",
  }[tone];

  return (
    <div className="rounded-[10px] border border-border-subtle bg-bg-subtle/40 p-4">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      <div className={`mt-2 truncate text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

function AccountRow({ account }) {
  const status = getStatusMeta(account.statusCounts, account.lastStatus);

  return (
    <tr className="border-b border-border/60 last:border-b-0 hover:bg-bg-subtle/50 transition-colors">
      <td className="px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-text-main">{account.label}</span>
          <span className="truncate text-xs text-text-muted">{account.secondary}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{fmt(account.requests)}</td>
      <td className="px-4 py-3 text-right tabular-nums text-text-muted">{fmt(account.promptTokens)}</td>
      <td className="px-4 py-3 text-right tabular-nums text-text-muted">{fmt(account.completionTokens)}</td>
      <td className="px-4 py-3 text-right tabular-nums font-medium">{fmt(account.totalTokens)}</td>
      <td className="px-4 py-3 text-right tabular-nums text-warning">{fmtCost(account.cost)}</td>
      <td className="px-4 py-3 text-right">
        <Badge variant={status.variant} size="sm">{status.label}</Badge>
      </td>
      <td className="px-4 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(account.lastUsed)}</td>
    </tr>
  );
}

export default function ProviderUsagePanel({ providerId, providerInfo }) {
  const [period, setPeriod] = useState("today");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    const params = new URLSearchParams({
      period,
      tzOffsetMinutes: String(tzOffsetMinutes),
      provider: providerId,
    });

    fetch(`/api/usage/providers-breakdown?${params.toString()}`, { signal: controller.signal })
      .then((res) => res.ok ? res.json() : res.json().then((body) => Promise.reject(new Error(body?.error || "Failed to fetch provider usage"))))
      .then((payload) => setData(payload))
      .catch((err) => {
        if (err.name !== "AbortError") {
          setError(err.message || "Failed to fetch provider usage");
          setData(null);
        }
      });

    return () => controller.abort();
  }, [period, providerId]);

  const provider = useMemo(() => {
    const first = data?.providers?.[0];
    return first || { ...EMPTY_PROVIDER, id: providerId, accounts: [] };
  }, [data, providerId]);

  const handlePeriodChange = (nextPeriod) => {
    if (nextPeriod === period) return;
    setPeriod(nextPeriod);
    setData(null);
    setError("");
  };

  const status = getStatusMeta(provider.statusCounts, provider.lastStatus);
  const isLoading = !data && !error;

  return (
    <Card padding="none" className="min-w-0 overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-border px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderMark providerId={providerId} providerInfo={providerInfo} />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-text-muted">Usage</p>
            <h2 className="truncate text-lg font-semibold text-text-main">
              {providerInfo?.name || providerId}
            </h2>
            <p className="truncate text-sm text-text-muted">
              {fmt(provider.accountCount)} accounts / {fmt(provider.requests)} requests / {fmtTime(provider.lastUsed)}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Badge variant={status.variant} size="sm">{status.label}</Badge>
          <SegmentedControl
            options={PERIODS}
            value={period}
            onChange={handlePeriodChange}
            size="sm"
            className="w-full sm:w-auto"
          />
        </div>
      </div>

      {error ? (
        <div className="px-4 py-4 text-sm text-danger">{error}</div>
      ) : null}

      <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-2 xl:grid-cols-6">
        <MetricTile label="Requests" value={fmt(provider.requests)} tone="primary" />
        <MetricTile label="Accounts" value={fmt(provider.accountCount)} />
        <MetricTile label="Input Tokens" value={fmt(provider.promptTokens)} tone="primary" />
        <MetricTile label="Output Tokens" value={fmt(provider.completionTokens)} tone="success" />
        <MetricTile label="Total Tokens" value={fmt(provider.totalTokens)} tone="success" />
        <MetricTile label="Est. Cost" value={fmtCost(provider.cost)} tone="warning" />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10 text-text-muted">
          <span className="material-symbols-outlined text-[28px] animate-spin">progress_activity</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-sm">
            <thead className="bg-bg-subtle/40 text-left text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-4 py-3">Key / Account</th>
                <th className="px-4 py-3 text-right">Requests</th>
                <th className="px-4 py-3 text-right">Input</th>
                <th className="px-4 py-3 text-right">Output</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Est. Cost</th>
                <th className="px-4 py-3 text-right">Status</th>
                <th className="px-4 py-3 text-right">Last Used</th>
              </tr>
            </thead>
            <tbody>
              {provider.accounts.map((account) => (
                <AccountRow key={account.id} account={account} />
              ))}
              {provider.accounts.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-text-muted">
                    No account usage in this period.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
