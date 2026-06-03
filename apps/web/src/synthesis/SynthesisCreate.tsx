/**
 * SynthesisCreate (T095) — the "New synthesis note" entry point at `/synthesis/new`.
 *
 * A tiny screen that prompts for a title, creates a `synthesis_note` element through
 * the typed `synthesis.create` bridge (`create_element`), and navigates to the new
 * note's editor (`/synthesis/$id`). Reachable from the command palette ("New synthesis
 * note") and the Library so a synthesis note is never an isolated UI. The renderer
 * holds no SQL — it ships an intent and routes to what main created.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { appApi, isDesktop } from "../lib/appApi";
import "./synthesis.css";

export function SynthesisCreate() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const create = useCallback(async () => {
    const trimmed = title.trim();
    if (!desktop || !trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await appApi.createSynthesisNote({ title: trimmed });
      void navigate({ to: "/synthesis/$id", params: { id: res.element.id } });
    } catch {
      setError("Could not create the synthesis note.");
      setBusy(false);
    }
  }, [desktop, title, busy, navigate]);

  if (!desktop) {
    return (
      <div className="reader-state" data-testid="route-synthesis-new">
        <span className="reader-state__icon">
          <Icon name="synthesis" size={26} />
        </span>
        <h1 className="font-semibold text-text text-xl tracking-tight">New synthesis note</h1>
        <p className="max-w-sm">
          Synthesis notes are created through the desktop bridge — open the Electron app.
        </p>
      </div>
    );
  }

  return (
    <div className="synthesis-create" data-testid="route-synthesis-new">
      <div className="synthesis-create__card">
        <span className="synthesis-create__icon">
          <Icon name="synthesis" size={22} />
        </span>
        <h1 className="synthesis-create__title">New synthesis note</h1>
        <p className="synthesis-create__hint">
          A long-lived writing surface that collects extracts &amp; cards and returns for
          incremental refinement.
        </p>
        <input
          ref={inputRef}
          className="synthesis-create__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder="What are you weaving together?"
          aria-label="Synthesis note title"
          data-testid="synthesis-create-title"
          maxLength={256}
        />
        {error ? (
          <p className="text-danger text-sm" data-testid="synthesis-create-error">
            {error}
          </p>
        ) : null}
        <div className="synthesis-create__actions">
          <button
            type="button"
            className="reader-btn"
            onClick={() => void navigate({ to: "/library" })}
          >
            Cancel
          </button>
          <button
            type="button"
            className="reader-btn reader-btn--primary"
            data-testid="synthesis-create-save"
            disabled={busy || title.trim().length === 0}
            onClick={() => void create()}
          >
            <Icon name="plus" size={14} /> Create note
          </button>
        </div>
      </div>
    </div>
  );
}
