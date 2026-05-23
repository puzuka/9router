"use client";

import { useCallback, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Button, Card, Input, SegmentedControl } from "@/shared/components";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7day", label: "7 day" },
  { value: "30day", label: "30 day" },
];

const MODES = [
  { value: "tokens", label: "Token" },
  { value: "cost", label: "Cost" },
];

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

const METRIC_LABELS = {
  promptTokens: "Input tokens",
  completionTokens: "Output tokens",
  totalTokens: "Total tokens",
  cost: "Cost",
};

function fmtTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

function fmtQuotaValue(value, metric) {
  return metric === "cost" ? fmtCost(value) : fmt(value);
}

function fmtPeriod(period) {
  if (period === "7d") return "7 day";
  if (period === "30d") return "30 day";
  return period;
}

export default function CheckQuotaPage() {
  const [apiKey, setApiKey] = useState("");
  const [period, setPeriod] = useState("today");
  const [mode, setMode] = useState("tokens");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasSearched, setHasSearched] = useState(false);

  const handleCheck = useCallback(async (nextPeriod = period) => {
    const trimmedApiKey = apiKey.trim();
    const selectedPeriod = typeof nextPeriod === "string" ? nextPeriod : period;
    if (!trimmedApiKey) {
      setError("Please enter an API key");
      return;
    }

    setLoading(true);
    setError("");
    setHasSearched(true);

    try {
      const tzOffsetMinutes = new Date().getTimezoneOffset();
      const response = await fetch("/api/check-quota", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmedApiKey, period: selectedPeriod, tzOffsetMinutes }),
        cache: "no-store",
      });

      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || "Failed to load usage");
      }

      const result = await response.json();
      setData(result);
    } catch (e) {
      setError(e.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [apiKey, period]);

  const handlePeriodChange = (newPeriod) => {
    setPeriod(newPeriod);
    if (data && apiKey.trim()) handleCheck(newPeriod);
  };

  const totals = data?.stats || {};
  const chartData = data?.chart || [];
  const requests = data?.requests || [];
  const quotas = data?.quotas || [];
  const hasChartData = chartData.some((item) => item.tokens > 0 || item.cost > 0);

  return (
    <div className="min-h-screen bg-bg p-4 sm:p-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Check API Key Quota</h1>
          <p className="mt-2 text-text-muted">Enter your API key to view usage statistics and quota limits</p>
        </div>

        <Card className="mb-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label htmlFor="apiKey" className="mb-2 block text-sm font-medium">
                API Key
              </label>
              <Input
                id="apiKey"
                type="password"
                placeholder="sk-xxxxxxxxxxxxxxxx-xxxxxx-xxxxxxxx"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCheck();
                }}
              />
            </div>
            <Button onClick={() => handleCheck()} disabled={loading || !apiKey.trim()}>
              {loading ? "Checking..." : "Check Usage"}
            </Button>
          </div>
        </Card>

        {error && (
          <Card className="mb-6">
            <p className="text-sm text-red-500">{error}</p>
          </Card>
        )}

        {hasSearched && !loading && !error && !data && (
          <Card>
            <p className="text-sm text-text-muted">No data found for this API key</p>
          </Card>
        )}

        {data && (
          <>
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold">{data.key?.name || "API Key Usage"}</h2>
                {data.key && <p className="text-sm text-text-muted">Created {new Date(data.key.createdAt).toLocaleDateString()}</p>}
              </div>
              <div className="flex flex-col gap-2 sm:items-end">
                <SegmentedControl options={PERIODS} value={period} onChange={handlePeriodChange} size="sm" />
                <SegmentedControl options={MODES} value={mode} onChange={setMode} size="sm" />
              </div>
            </div>

            <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Card padding="sm">
                <p className="text-xs uppercase text-text-muted">Requests</p>
                <p className="mt-1 text-2xl font-semibold">{fmt(totals.totalRequests)}</p>
              </Card>
              <Card padding="sm">
                <p className="text-xs uppercase text-text-muted">Input Tokens</p>
                <p className="mt-1 text-2xl font-semibold">{fmt(totals.totalPromptTokens)}</p>
              </Card>
              <Card padding="sm">
                <p className="text-xs uppercase text-text-muted">Output Tokens</p>
                <p className="mt-1 text-2xl font-semibold">{fmt(totals.totalCompletionTokens)}</p>
              </Card>
              <Card padding="sm">
                <p className="text-xs uppercase text-text-muted">Cost</p>
                <p className="mt-1 text-2xl font-semibold text-warning">{fmtCost(totals.totalCost)}</p>
              </Card>
            </div>

            {quotas.length > 0 && (
              <div className="mb-6 grid gap-3 lg:grid-cols-2">
                {quotas.map((quota) => (
                  <Card key={quota.id} padding="sm" className="min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs uppercase text-text-muted">{METRIC_LABELS[quota.metric] || quota.metric} quota</p>
                        <p className="mt-1 text-sm text-text-muted">{fmtPeriod(quota.period)} window</p>
                      </div>
                      <span className={`rounded px-2 py-1 text-xs font-medium ${quota.overLimit ? "bg-red-500/10 text-red-500" : "bg-primary/10 text-primary"}`}>
                        {quota.percentUsed.toFixed(1)}% used
                      </span>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                      <div className={`h-full rounded-full ${quota.overLimit ? "bg-red-500" : "bg-primary"}`} style={{ width: `${Math.min(100, quota.percentUsed)}%` }} />
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <p className="text-xs text-text-muted">Used</p>
                        <p className="font-semibold">{fmtQuotaValue(quota.used, quota.metric)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-text-muted">Remaining</p>
                        <p className="font-semibold">{fmtQuotaValue(quota.remaining, quota.metric)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-text-muted">Limit</p>
                        <p className="font-semibold">{fmtQuotaValue(quota.limitValue, quota.metric)}</p>
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-text-muted">Reset {quota.resetAt ? fmtTime(quota.resetAt) : "-"}</p>
                  </Card>
                ))}
              </div>
            )}

            <Card className="mb-6 min-w-0 p-3 sm:p-4">
              {!hasChartData ? (
                <div className="flex h-56 items-center justify-center text-sm text-text-muted">No data for this period</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.12} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.6 }} tickLine={false} axisLine={false} tickFormatter={mode === "tokens" ? fmt : fmtCost} width={58} />
                    <Tooltip formatter={(value) => mode === "tokens" ? [fmt(value), "Tokens"] : [fmtCost(value), "Cost"]} />
                    <Area type="monotone" dataKey={mode === "tokens" ? "tokens" : "cost"} stroke={mode === "tokens" ? "#6366f1" : "#f59e0b"} strokeWidth={2} fill={mode === "tokens" ? "#6366f133" : "#f59e0b33"} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </Card>

            <Card className="overflow-hidden">
              <div className="border-b border-border p-4">
                <h2 className="font-semibold">Recent Requests</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-bg-subtle/50 text-xs uppercase text-text-muted">
                    <tr>
                      <th className="px-4 py-3">Time</th>
                      <th className="px-4 py-3">Model</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Endpoint</th>
                      <th className="px-4 py-3 text-right">Input</th>
                      <th className="px-4 py-3 text-right">Output</th>
                      <th className="px-4 py-3 text-right">Cached</th>
                      <th className="px-4 py-3 text-right">Reasoning</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Cost</th>
                      <th className="px-4 py-3 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {requests.map((r, index) => (
                      <tr key={`${r.timestamp}-${index}`} className="hover:bg-bg-subtle/40">
                        <td className="whitespace-nowrap px-4 py-3 text-text-muted">{fmtTime(r.timestamp)}</td>
                        <td className="px-4 py-3 font-mono">{r.model || "-"}</td>
                        <td className="px-4 py-3">
                          <Badge variant="neutral" size="sm">{r.provider || "-"}</Badge>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{r.endpoint || "-"}</td>
                        <td className="px-4 py-3 text-right">{fmt(r.promptTokens)}</td>
                        <td className="px-4 py-3 text-right">{fmt(r.completionTokens)}</td>
                        <td className="px-4 py-3 text-right">{fmt(r.cachedTokens)}</td>
                        <td className="px-4 py-3 text-right">{fmt(r.reasoningTokens)}</td>
                        <td className="px-4 py-3 text-right font-medium">{fmt(r.totalTokens)}</td>
                        <td className="px-4 py-3 text-right text-warning">{fmtCost(r.cost)}</td>
                        <td className="px-4 py-3 text-right">{r.status || "ok"}</td>
                      </tr>
                    ))}
                    {!requests.length && (
                      <tr>
                        <td colSpan={11} className="px-4 py-8 text-center text-text-muted">
                          No requests for this period.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
