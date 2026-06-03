/**
 * Expiry banner (T090) — the calm, POST-REVEAL "this fact may be out of date" line a
 * stale card shows in review. It rides the existing reveal gate (rendered only inside
 * the `revealed` block, exactly like the refblock) so it can NEVER leak the answer.
 *
 * Two restrained tones, built from the existing `.banner` primitive + the design
 * tokens (no playful widget):
 *  - `expired` (`now > valid_until`) → a `--danger` banner: "This fact may be out of
 *    date (expired {date})".
 *  - `due_for_review` (`now > review_by`) → a softer `--warn` banner: "Due for review
 *    by {date}".
 *
 * The derived `status` is computed MAIN-side (`deriveExpiryStatus`); this component
 * only renders it. A fresh / lifetime-less card carries `expiry: null` and renders
 * nothing. The optional "Create verify task" affordance (T092) — when `onCreateTask`
 * is supplied — lets the user turn a stale fact into a scheduled `task`-type element
 * (`tasks.create` with `taskType: "verify_claim"` + the card's id) without leaving
 * review; it rides the same post-reveal gate so it never leaks the answer.
 */

import { useState } from "react";
import { Icon } from "../components/Icon";
import type { ReviewCardExpiry } from "../lib/appApi";

/** The jurisdiction/version context line shown under the banner title, or `null`. */
function contextLine(expiry: ReviewCardExpiry): string | null {
  const parts: string[] = [];
  if (expiry.softwareVersion) parts.push(expiry.softwareVersion);
  if (expiry.jurisdiction) parts.push(expiry.jurisdiction);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function ExpiryBanner({
  expiry,
  onCreateTask,
}: {
  expiry: ReviewCardExpiry;
  /** When supplied (T092), render a "Create verify task" button that calls this. */
  onCreateTask?: () => void | Promise<void>;
}) {
  const expired = expiry.status === "expired";
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const title = expired
    ? expiry.validUntil
      ? `This fact may be out of date (expired ${expiry.validUntil})`
      : "This fact may be out of date"
    : expiry.reviewBy
      ? `Due for review by ${expiry.reviewBy}`
      : "Due for review";
  const context = contextLine(expiry);

  const handleCreate = async () => {
    if (!onCreateTask || busy || done) return;
    setBusy(true);
    try {
      await onCreateTask();
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`banner ${expired ? "banner--expired" : "banner--review"}`}
      data-testid="review-expiry-banner"
      data-expiry-status={expiry.status}
      style={{ marginTop: 16 }}
    >
      <Icon name={expired ? "hourglass" : "calendar"} size={16} />
      <div>
        <div className="banner__title">{title}</div>
        <div className="banner__body">
          {expired
            ? "Verify the claim is still current before relying on it."
            : "Re-check this claim — it may have changed since it was last verified."}
          {context ? ` (${context})` : ""}
        </div>
        {onCreateTask ? (
          <button
            type="button"
            className="banner__action"
            data-testid="review-create-verify-task"
            disabled={busy || done}
            onClick={() => void handleCreate()}
          >
            <Icon name="task" size={13} />
            {done ? "Verify task created" : "Create verify task"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
