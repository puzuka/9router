"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";

function normalizeSessions(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.sessions)) return value.sessions;
  return [value];
}

function hasAccessToken(session) {
  if (typeof session === "string") return session.trim().length > 0;
  if (!session || typeof session !== "object") return false;
  return Boolean(session.accessToken || session.access_token);
}

export default function CodexSessionImportModal({ isOpen, onSuccess, onClose }) {
  const [sessionText, setSessionText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);

  const handleClose = () => {
    if (loading) return;
    setSessionText("");
    setError("");
    setResults(null);
    onClose();
  };

  const handleImport = async () => {
    setError("");
    setResults(null);

    const trimmed = sessionText.trim();
    if (!trimmed) {
      setError("Paste ChatGPT session JSON first");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      setError("Invalid JSON. Paste the full response from chatgpt.com/api/auth/session.");
      return;
    }

    const sessions = normalizeSessions(payload);
    if (!sessions.some(hasAccessToken)) {
      setError("No accessToken found in the JSON.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/oauth/codex/import-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to import ChatGPT session");

      setResults(data);
      if (data.success) onSuccess?.();
    } catch (err) {
      setError(err.message || "Failed to import ChatGPT session");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Import ChatGPT Session" onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        <div className="space-y-3 text-sm text-text-muted">
          <p>Paste ChatGPT session JSON to add it as a Codex OAuth connection.</p>
          <div className="rounded-[10px] border border-border bg-surface-2 p-3">
            <p className="mb-1 font-medium text-text-main">How to get the session JSON</p>
            <ol className="list-decimal space-y-1 pl-4 text-xs">
              <li>Sign in to ChatGPT in your browser.</li>
              <li>
                Open{" "}
                <code className="rounded bg-background px-1 py-0.5 text-text-main">
                  https://chatgpt.com/api/auth/session
                </code>
              </li>
              <li>Paste the full JSON response here.</li>
            </ol>
          </div>
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Session tokens are sensitive. Only import sessions from accounts you control.
          </p>
        </div>

        <textarea
          value={sessionText}
          onChange={(e) => setSessionText(e.target.value)}
          placeholder='{"user":{"email":"you@example.com"},"expires":"2026-06-01T00:00:00.000Z","accessToken":"eyJ..."}'
          className="min-h-48 w-full resize-y rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-[13px] text-text-main placeholder-text-muted/70 transition-all duration-150 ease-out focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          disabled={loading}
        />

        {error && (
          <p className="flex items-center gap-1 text-xs text-red-500">
            <span className="material-symbols-outlined text-[14px]">error</span>
            {error}
          </p>
        )}

        {results && (
          <div className={`rounded-[10px] border p-3 text-sm ${results.success ? "border-green-500/25 bg-green-500/10 text-green-700 dark:text-green-300" : "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300"}`}>
            <p className="mb-1 font-medium">
              {results.success ? "Import complete" : "Import failed"}
            </p>
            <p>Imported: {results.imported || 0}</p>
            <p>Failed: {results.failed || 0}</p>
            {results.connections?.map((connection) => (
              <p key={`${connection.index}-${connection.connectionId}`} className="mt-1 text-xs">
                - {connection.email || "Unknown account"}{connection.plan ? ` (${connection.plan})` : ""}
              </p>
            ))}
            {results.errors?.map((item) => (
              <p key={`${item.index}-${item.error}`} className="mt-1 text-xs text-red-600 dark:text-red-400">
                - #{item.index + 1}: {item.error}
              </p>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          {!results?.success && (
            <Button onClick={handleImport} loading={loading} disabled={!sessionText.trim()} fullWidth>
              Import
            </Button>
          )}
          <Button onClick={handleClose} variant={results?.success ? "primary" : "ghost"} disabled={loading} fullWidth>
            {results?.success ? "Done" : "Cancel"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

CodexSessionImportModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
