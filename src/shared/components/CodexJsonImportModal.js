"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";

export default function CodexJsonImportModal({ isOpen, onSuccess, onClose }) {
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleClose = () => {
    if (loading) return;
    setJsonText("");
    setError("");
    onClose();
  };

  const handleImport = async () => {
    setError("");
    setLoading(true);
    try {
      const trimmed = jsonText.trim();
      if (!trimmed) throw new Error("Paste Codex JSON first");

      const payload = JSON.parse(trimmed);
      const res = await fetch("/api/oauth/codex/import-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to import Codex JSON");

      setJsonText("");
      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message || "Failed to import Codex JSON");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Import OpenAI Codex JSON" onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm font-medium mb-2">Codex JSON</p>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder='{ "accessToken": "eyJ...", "expiresAt": "2026-06-01T17:16:09.000Z", "provider": "codex" }'
            className="min-h-44 w-full resize-y rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-[13px] text-text-main placeholder-text-muted/70 transition-all duration-150 ease-out focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            disabled={loading}
          />
          {error && (
            <p className="mt-2 flex items-center gap-1 text-xs text-red-500">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {error}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <Button onClick={handleImport} loading={loading} disabled={!jsonText.trim()} fullWidth>
            Import
          </Button>
          <Button onClick={handleClose} variant="ghost" disabled={loading} fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

CodexJsonImportModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
