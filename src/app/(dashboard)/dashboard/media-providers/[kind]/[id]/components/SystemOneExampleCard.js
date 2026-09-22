"use client";

import { useState, useEffect } from "react";
import { Card } from "@/shared/components";
import { MEDIA_PROVIDER_KINDS, getProviderAlias, resolveProviderId } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { Row } from "./exampleShared";

const DEFAULT_STATE = {
  task: "Review a proposed change before a human decides whether to merge it.",
  diff_summary: "Reject an empty project name before writing a record.",
  test_summary: "The new empty-name test and existing creation tests pass. No integration tests were run.",
};

const DEFAULT_QUESTIONS = {
  review: {
    type: "choice",
    instructions: "Does the supplied evidence support accepting this change, or does it need further review? Treat missing evidence as a reason to review.",
    criteria: {
      accept: "The described change meets the task and the supplied tests cover its relevant behavior.",
      review: "Evidence is missing, the tests are insufficient, or the change may be incorrect.",
    },
  },
};

const DEFAULT_RESPONSE = `{
  "model": "jev-1.13.0",
  "answers": {
    "review": {
      "type": "choice",
      "choice": "review",
      "confidence": 0.97,
      "probabilities": { "accept": 0.01, "review": 0.99 }
    }
  },
  "usage": { "input_tokens": 416, "output_tokens": 31 }
}`;

function JsonField({ label, value, onChange, rows = 8 }) {
  return (
    <Row label={label}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className="w-full px-3 py-2 text-xs font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-y"
      />
    </Row>
  );
}

export function SystemOneExampleCard({ providerId, alias: aliasOverride }) {
  let providerAlias;
  if (aliasOverride) {
    // Custom compatible nodes: use the node prefix directly (getProviderAlias
    // only knows built-in registry entries).
    providerAlias = aliasOverride;
  } else {
    const builtinAlias = getProviderAlias(providerId);
    const resolvedId = resolveProviderId(builtinAlias);
    providerAlias = resolvedId === providerId ? builtinAlias : providerId;
  }
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === "systemOne");

  const kindModels = getModelsByProviderId(providerId).filter((m) => getModelKind(m) === "systemOne");
  const [selectedModel, setSelectedModel] = useState(kindModels[0]?.id ?? "");

  const [stateJson, setStateJson] = useState(() => JSON.stringify(DEFAULT_STATE, null, 2));
  const [questionsJson, setQuestionsJson] = useState(() => JSON.stringify(DEFAULT_QUESTIONS, null, 2));
  const [apiKey, setApiKey] = useState("");
  const [useTunnel, setUseTunnel] = useState(false);
  const [localEndpoint, setLocalEndpoint] = useState("");
  const [tunnelEndpoint, setTunnelEndpoint] = useState("");
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [connections, setConnections] = useState([]);
  const [pinnedConnectionId, setPinnedConnectionId] = useState("");
  const { copied: copiedCurl, copy: copyCurl } = useCopyToClipboard();
  const { copied: copiedRes, copy: copyRes } = useCopyToClipboard();

  useEffect(() => {
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => { setApiKey((d.keys || []).find((k) => k.isActive !== false)?.key || ""); })
      .catch(() => {});
    fetch("/api/tunnel/status")
      .then((r) => r.json())
      .then((d) => { if (d.publicUrl) setTunnelEndpoint(d.publicUrl); })
      .catch(() => {});
    fetch("/api/providers/client")
      .then((r) => r.json())
      .then((d) => {
        const conns = (d.connections || []).filter((c) => c.provider === providerId && c.isActive !== false);
        setConnections(conns);
      })
      .catch(() => {});
  }, [providerId]);

  if (!kindConfig) return null;

  // window is unavailable during SSR — fall back at render time instead of setState-in-effect
  const localOrigin = localEndpoint || (typeof window !== "undefined" ? window.location.origin : "");
  const endpoint = useTunnel ? tunnelEndpoint : localOrigin;
  const apiPath = kindConfig.endpoint.path;
  // Provider IS the model — "alias" or "alias/model" both resolve server-side
  const modelFull = selectedModel ? `${providerAlias}/${selectedModel}` : providerAlias;

  let stateParsed, questionsParsed;
  try {
    stateParsed = JSON.parse(stateJson || "{}");
    questionsParsed = JSON.parse(questionsJson || "{}");
  } catch {
    stateParsed = null;
    questionsParsed = null;
  }
  const jsonValid = !!stateParsed && !!questionsParsed;

  const requestBody = { model: modelFull, state: stateParsed || {}, questions: questionsParsed || {} };
  const headersPreview = [
    '-H "Content-Type: application/json"',
    ...(pinnedConnectionId ? [`-H "x-connection-id: ${pinnedConnectionId}"`] : []),
    `-H "Authorization: Bearer ${apiKey || "YOUR_KEY"}"`,
  ].join(" \\\n  ");
  const curlSnippet = `curl -X ${kindConfig.endpoint.method} ${endpoint}${apiPath} \\
  ${headersPreview} \\
  -d '${JSON.stringify(requestBody)}'`;

  const handleRun = async () => {
    if (!jsonValid || running) return;
    setRunning(true);
    setError("");
    setResult(null);
    const start = Date.now();
    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      if (pinnedConnectionId) headers["x-connection-id"] = pinnedConnectionId;
      const res = await fetch(`/api${apiPath}`, {
        method: kindConfig.endpoint.method,
        headers,
        body: JSON.stringify(requestBody),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error?.message || data?.error || `HTTP ${res.status}`);
        return;
      }
      setResult({ data, latencyMs: Date.now() - start });
    } catch (e) {
      setError(e.message || "Network error");
    } finally {
      setRunning(false);
    }
  };

  const resultJson = result ? JSON.stringify(result.data, null, 2) : "";

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-4">Example</h2>
      <div className="flex flex-col gap-2.5">
        {/* Model selector */}
        {kindModels.length > 0 && (
          <Row label="Model">
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
            >
              {kindModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name || m.id}</option>
              ))}
            </select>
          </Row>
        )}

        {/* Endpoint */}
        <Row label="Endpoint">
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <span className="w-full min-w-0 flex-1 px-3 py-1.5 text-sm font-mono text-text-main bg-sidebar rounded-lg truncate">
              {endpoint}{apiPath}
            </span>
            {tunnelEndpoint && (
              <button
                onClick={() => setUseTunnel((v) => !v)}
                title={useTunnel ? "Using tunnel" : "Using local"}
                className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg border shrink-0 transition-colors ${
                  useTunnel ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-text-muted hover:text-primary"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">wifi_tethering</span>
                Tunnel
              </button>
            )}
          </div>
        </Row>

        {/* API Key */}
        <Row label="API Key">
          <span className="px-3 py-1.5 text-sm font-mono text-text-main bg-sidebar rounded-lg truncate block">
            {apiKey ? `${apiKey.slice(0, 8)}${"\u2022".repeat(Math.min(20, Math.max(0, apiKey.length - 8)))}` : <span className="text-text-muted italic">No key configured</span>}
          </span>
        </Row>

        {/* Connection picker */}
        {connections.length > 0 && (
          <Row label="Connection">
            <select
              value={pinnedConnectionId}
              onChange={(e) => setPinnedConnectionId(e.target.value)}
              className="w-full px-3 py-1.5 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
            >
              <option value="">Auto (by priority)</option>
              {connections.map((c) => {
                const label = c.email || c.name || c.id.slice(0, 8);
                return <option key={c.id} value={c.id}>{label}</option>;
              })}
            </select>
          </Row>
        )}

        {/* State + Questions (structured payload) */}
        <JsonField label="State" value={stateJson} onChange={setStateJson} />
        <JsonField label="Questions" value={questionsJson} onChange={setQuestionsJson} />
        {!jsonValid && (
          <p className="text-xs text-red-500">State and Questions must be valid JSON objects.</p>
        )}

        {/* Curl + Run */}
        <div className="mt-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-1.5">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">Request</span>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <button
                onClick={() => copyCurl(curlSnippet)}
                className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">{copiedCurl ? "check" : "content_copy"}</span>
                {copiedCurl ? "Copied" : "Copy"}
              </button>
              <button
                onClick={handleRun}
                disabled={running || !jsonValid}
                className="flex w-full sm:w-auto items-center justify-center gap-1.5 px-3 py-1 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[14px]" style={running ? { animation: "spin 1s linear infinite" } : undefined}>
                  play_arrow
                </span>
                {running ? "Running..." : "Run"}
              </button>
            </div>
          </div>
          <pre className="bg-sidebar rounded-lg px-3 py-2.5 text-xs font-mono text-text-main overflow-x-auto whitespace-pre-wrap break-all">{curlSnippet}</pre>
        </div>

        {/* Error */}
        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        {/* Response */}
        <div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-1.5">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              Response {result && <span className="font-normal normal-case">&#9889; {result.latencyMs}ms</span>}
            </span>
            {result && (
              <button
                onClick={() => copyRes(resultJson)}
                className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">{copiedRes ? "check" : "content_copy"}</span>
                {copiedRes ? "Copied" : "Copy"}
              </button>
            )}
          </div>
          <pre className="bg-sidebar rounded-lg px-3 py-2.5 text-xs font-mono text-text-main overflow-x-auto whitespace-pre-wrap break-all opacity-70">
            {result ? resultJson : DEFAULT_RESPONSE}
          </pre>
        </div>
      </div>
    </Card>
  );
}
