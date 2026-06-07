/**
 * BalanceBanner (T046) — the import/process balance warning.
 *
 * Rebuilt from the design kit's `Banner` (`design/kit/app/components.jsx` + the
 * `.banner` styles in `design/kit/styles/app.css`) for React 19 + Tailwind v4: a
 * left warning icon, a title + body, and trailing soft actions. It catches the
 * core failure mode of incremental reading — importing faster than you process —
 * and shows the four weekly headline numbers (sources imported / extracts created
 * / cards created / reviews due this week).
 *
 * Architecture (non-negotiable): UI ONLY. The numbers + the imbalance judgment are
 * computed in the DOMAIN layer (`packages/local-db` `AnalyticsService.computeBalance`
 * + the pure `@interleave/core` `judgeBalance` rule); this component just READS one
 * `balance.get()` payload through the typed `window.appApi` bridge and renders it.
 * It also respects the `balanceWarnings` on/off setting (read via `settings.getAll`).
 * Advisory only — it never postpones or deletes (auto-postpone is M16/T077).
 *
 * Shared by the inbox (`screen-inbox`) and the analytics view (`screen-analytics`)
 * so both surfaces read the SAME computed numbers and can never disagree. Renders
 * `null` when the warning is disabled, the snapshot is `ok`, no current action is
 * available, or we are not running inside the desktop shell.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { appApi, type BalanceGetResult, isDesktop } from "../lib/appApi";
import { UNDO_EVENT } from "../shell/nav";
import { Icon } from "./Icon";

export interface BalanceBannerProps {
  /** Optional instant to compute the snapshot for (ISO-8601); defaults to "now". */
  readonly asOf?: string;
  /**
   * Bump to force a re-fetch (e.g. after the host triages an item or imports a
   * source) so the banner reflects the latest counts without a full remount.
   */
  readonly refreshKey?: number;
}

export function BalanceBanner({ asOf, refreshKey = 0 }: BalanceBannerProps) {
  const navigate = useNavigate();
  const [data, setData] = useState<BalanceGetResult | null>(null);
  const [enabled, setEnabled] = useState(true);

  const load = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      // Read the on/off setting + the snapshot together. The snapshot is always
      // computed main-side; the toggle only governs whether we surface it here.
      const [{ settings }, snapshot] = await Promise.all([
        appApi.getAppSettings(),
        appApi.getBalance(asOf ? { asOf } : undefined),
      ]);
      setEnabled(settings.balanceWarnings);
      setData(snapshot);
    } catch {
      // Advisory banner: a read failure simply hides it (never blocks the screen).
      setData(null);
    }
  }, [asOf]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate re-fetch trigger
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Re-read after a global undo (⌘Z) so a restored/undeleted item updates counts.
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(UNDO_EVENT, handler);
    return () => window.removeEventListener(UNDO_EVENT, handler);
  }, [load]);

  const hasDueQueueWork = (data?.dueQueueItems ?? 0) > 0;
  const hasInboxWork = (data?.inboxSources ?? 0) > 0;

  // Hidden when disabled, balanced, no data, or there is no honest action to offer.
  if (!enabled || !data?.imbalanced || (!hasDueQueueWork && !hasInboxWork)) return null;

  const guidance =
    hasDueQueueWork && hasInboxWork
      ? "Process queue work or triage inbox sources before importing more."
      : hasDueQueueWork
        ? "Open the queue before importing more."
        : "Triage inbox sources before importing more.";

  const danger = data.severity === "danger";
  const tone = danger
    ? "border-danger bg-danger-soft text-text"
    : "border-warn bg-warn-soft text-text";
  const iconTone = danger ? "text-danger" : "text-warn";

  return (
    <div
      className={`flex items-start gap-3 rounded-md border px-4 py-3 text-sm ${tone}`}
      data-testid="balance-banner"
      data-severity={data.severity}
      role="status"
    >
      <span className={`mt-0.5 flex-none ${iconTone}`}>
        <Icon name="warning" size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold" data-testid="balance-banner-title">
          You're importing faster than you process
        </div>
        <div className="mt-0.5 text-text-2">
          <span data-testid="balance-sources">{data.sourcesImported}</span> source
          {data.sourcesImported === 1 ? "" : "s"} in this week, but only{" "}
          <span data-testid="balance-extracts">{data.extractsCreated}</span> extract
          {data.extractsCreated === 1 ? "" : "s"} and{" "}
          <span data-testid="balance-cards">{data.cardsCreated}</span> card
          {data.cardsCreated === 1 ? "" : "s"} created —{" "}
          <span data-testid="balance-reviews">{data.reviewsDueThisWeek}</span> review
          {data.reviewsDueThisWeek === 1 ? "" : "s"} due this week. {guidance}
        </div>
      </div>
      <div className="ml-auto flex flex-none items-center gap-2">
        {hasDueQueueWork ? (
          <button
            type="button"
            data-testid="balance-open-queue"
            onClick={() => void navigate({ to: "/queue" })}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-sm text-text-2 hover:text-text"
          >
            <Icon name="play" size={13} />
            Open queue
          </button>
        ) : null}
        {hasInboxWork ? (
          <button
            type="button"
            data-testid="balance-triage-inbox"
            onClick={() => void navigate({ to: "/inbox" })}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-sm text-text-2 hover:text-text"
          >
            <Icon name="inbox" size={13} />
            Triage inbox
          </button>
        ) : null}
      </div>
    </div>
  );
}
