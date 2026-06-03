/**
 * ReviewModeButton (T096) — the calm "Review these" entry affordance.
 *
 * A small, additive button placed on the existing surfaces (concepts / search /
 * branch / source / stale / leech / random) that launches a TARGETED review session
 * over a chosen card SUBSET — OUTSIDE normal scheduling. It calls `review.modeCount`
 * to show the subset size, and is OMITTED when the subset is empty (a calm empty
 * state, never a dead button). On click it routes to `/review` with the typed
 * selector serialized into loose search params; the renderer NEVER computes the
 * selection — it sends a typed selector and the main side resolves it.
 *
 * No new screen: the review session itself is the unchanged T037 `ReviewScreen`,
 * generalized to run a mode (it reads the same loose search params back).
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { appApi, isDesktop, type ReviewModeSelector } from "../lib/appApi";

/** Serialize a typed selector into the loose `/review` search object the screen parses. */
export function reviewModeSearch(
  selector: ReviewModeSelector,
  asOf?: string,
): Record<string, string> {
  const base: Record<string, string> = { mode: selector.kind };
  switch (selector.kind) {
    case "concept":
      base.conceptId = selector.conceptId;
      break;
    case "source":
      base.sourceId = selector.sourceId;
      break;
    case "branch":
      base.rootId = selector.rootId;
      break;
    case "search":
    case "semantic":
      base.query = selector.query;
      break;
    case "random":
      base.size = String(selector.size);
      if (selector.seed !== undefined) base.seed = String(selector.seed);
      break;
    case "stale":
    case "leech":
      break;
  }
  if (asOf) base.asOf = asOf;
  return base;
}

interface ReviewModeButtonProps {
  readonly selector: ReviewModeSelector;
  /** Optional fixed-clock scope (the E2E drives `asOf`). */
  readonly asOf?: string;
  /** Override label text; defaults to "Review {count} cards". */
  readonly label?: (count: number) => string;
  /** When false, render nothing while the count is still loading (default: a quiet placeholder). */
  readonly hideWhileLoading?: boolean;
  readonly className?: string;
  readonly icon?: Parameters<typeof Icon>[0]["name"];
  readonly testId?: string;
}

/**
 * A "Review these" button that resolves its subset count via `review.modeCount` and
 * routes to the targeted review session. Renders NOTHING when the subset is empty.
 */
export function ReviewModeButton({
  selector,
  asOf,
  label,
  hideWhileLoading = false,
  className = "rv-mode-btn",
  icon = "target",
  testId = "review-mode-button",
}: ReviewModeButtonProps) {
  const navigate = useNavigate();
  const [count, setCount] = useState<number | null>(null);

  // Most call sites pass an inline `selector` object literal, so its identity changes
  // on every parent render. Re-derive a VALUE-stable request payload from the serialized
  // selector + asOf so the read-only `review.modeCount` IPC fires once per distinct
  // selector, not once per parent re-render. The memo round-trips through the JSON
  // digest, so it depends ONLY on the value (not the unstable object identities).
  const requestKey = JSON.stringify({ selector, ...(asOf ? { asOf } : {}) });
  const request = useMemo<Parameters<typeof appApi.reviewModeCount>[0]>(
    () => JSON.parse(requestKey),
    [requestKey],
  );

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await appApi.reviewModeCount(request);
        if (!cancelled) setCount(res.total);
      } catch {
        // A failed count → treat as empty (omit the button) rather than a dead one.
        if (!cancelled) setCount(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  // Empty subset → no button (a calm empty state, never a dead button).
  if (count === 0) return null;
  // Still loading: render nothing (or a quiet placeholder) until the count resolves.
  if (count === null) {
    if (hideWhileLoading) return null;
    return (
      <span className={`${className} ${className}--loading`} data-testid={`${testId}-loading`}>
        <Icon name={icon} size={13} /> Review…
      </span>
    );
  }

  const text = label ? label(count) : `Review ${count} card${count === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      onClick={() => navigate({ to: "/review", search: reviewModeSearch(selector, asOf) })}
    >
      <Icon name={icon} size={13} />
      {text}
    </button>
  );
}
