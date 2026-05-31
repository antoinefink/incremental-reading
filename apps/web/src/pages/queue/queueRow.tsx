/**
 * Shared, pure queue-row presentation helpers (T029 / Home command center).
 *
 * The per-row TITLE prefix ("Extract · …", "Q&A · …"), the open-action affordance
 * (icon + label per type), and the due-state `DueBadge` are needed by BOTH the
 * actionable Daily Queue list (`QueueScreen`) and the read-only top-due preview on
 * the Home command center (`HomeScreen`). They are extracted here so the two
 * surfaces can never drift — the slim preview reuses the SAME title/badge logic as
 * the full list WITHOUT pulling in the actionable `QueueItem` (its row actions,
 * schedule menu, selection wiring) which is queue-only.
 *
 * UI only — pure functions over the typed `window.appApi` `QueueItemSummary`; no
 * SQL, no scheduling math, no data fetching.
 */

import type { IconName } from "../../components/Icon";
import type { QueueItemSummary } from "../../lib/appApi";

/** The per-row title with the kit's type prefix ("Extract · …", "Q&A · …"). */
export function titleFor(item: QueueItemSummary): string {
  if (item.type === "card") {
    const prefix = item.cardType === "cloze" ? "Cloze · " : "Q&A · ";
    return prefix + item.title.replace(/\{\{(.+?)\}\}/, "[…]");
  }
  if (item.type === "extract") return `Extract · ${item.title}`;
  if (item.type === "topic") return `Topic · ${item.title}`;
  return item.title;
}

/** The open-action icon + label per type (the `next-action` affordance). */
export function actionFor(item: QueueItemSummary): { icon: IconName; label: string } {
  if (item.type === "card") return { icon: "brain", label: "Review" };
  if (item.type === "source") return { icon: "eye", label: "Read" };
  if (item.type === "extract") return { icon: "extract", label: "Process" };
  return { icon: "return", label: "Open" };
}

/** A due-state badge (overdue / today / soon) — distinct from the lifecycle `Status`. */
export function DueBadge({ item }: { item: QueueItemSummary }) {
  const cls =
    item.due === "overdue" ? "badge--overdue" : item.due === "today" ? "badge--due" : "badge--soft";
  return (
    <span className={`badge ${cls}`} data-testid="queue-due-badge">
      {item.dueLabel}
    </span>
  );
}
