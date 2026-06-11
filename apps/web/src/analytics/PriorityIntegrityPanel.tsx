import { forwardRef } from "react";
import { Icon } from "../components/Icon";
import type { PriorityIntegrityGetResult } from "../lib/appApi";

function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatDays(value: number): string {
  return value === 0 ? "0d" : `${Number.isInteger(value) ? value : value.toFixed(1)}d`;
}

function formatRate(value: number | null): string {
  if (value === null) return "-";
  return `${Math.round(value * 100)}%`;
}

function activeFlagLabels(data: PriorityIntegrityGetResult): readonly string[] {
  const labels: string[] = [];
  if (data.thresholdFlags.aBandInflation) labels.push("A-band share is high");
  if (data.thresholdFlags.aBandDeferredRecently) labels.push("A-band work was deferred");
  if (data.thresholdFlags.postponeDebtHigh) labels.push("Postpone debt is high");
  return labels;
}

export interface PriorityIntegrityPanelProps {
  readonly data: PriorityIntegrityGetResult | null;
  readonly error: string | null;
}

export const PriorityIntegrityPanel = forwardRef<HTMLElement, PriorityIntegrityPanelProps>(
  function PriorityIntegrityPanel({ data, error }, ref) {
    const flags = data ? activeFlagLabels(data) : [];

    return (
      <section
        className="an-panel an-priority"
        data-testid="priority-integrity"
        id="priority-integrity"
        ref={ref}
        tabIndex={-1}
      >
        <div className="an-panel__head">
          <span className="an-panel__title">Priority integrity</span>
          <span className="an-panel__meta">{data?.windowDays ?? 30} days</span>
        </div>

        {error ? (
          <p className="an-priority__error" data-testid="priority-integrity-error">
            {error}
          </p>
        ) : null}

        {data ? (
          <div className="an-priority__body">
            <div className="an-priority__flags" data-testid="priority-integrity-flags">
              {flags.length > 0 ? (
                flags.map((flag) => (
                  <span key={flag} className="an-priority__flag">
                    <Icon name="warning" size={13} />
                    {flag}
                  </span>
                ))
              ) : (
                <span className="an-priority__flag an-priority__flag--ok">
                  <Icon name="checkCircle" size={13} />
                  No priority-debt threshold crossed
                </span>
              )}
            </div>

            <div className="an-priority__bands" data-testid="priority-integrity-bands">
              {data.bands.map((band) => (
                <div key={band.band} className="an-priority__band">
                  <span className={`an-priority__prio an-priority__prio--${band.band}`}>
                    {band.band}
                  </span>
                  <div>
                    <span className="an-priority__value">
                      {formatCount(band.attentionServiced)}
                    </span>
                    <span className="an-priority__label">attention</span>
                  </div>
                  <div>
                    <span className="an-priority__value">{formatCount(band.fsrsServiced)}</span>
                    <span className="an-priority__label">FSRS</span>
                  </div>
                  <div>
                    <span className="an-priority__value">{formatCount(band.deferred)}</span>
                    <span className="an-priority__label">deferred</span>
                  </div>
                  <div>
                    <span className="an-priority__value">{formatDays(band.postponeDebtDays)}</span>
                    <span className="an-priority__label">debt</span>
                  </div>
                  <div>
                    <span className="an-priority__value">{formatRate(band.liveShare)}</span>
                    <span className="an-priority__label">live share</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="an-priority__columns">
              <div>
                <div className="an-priority__subhead">Topic anchors</div>
                {data.topics.length > 0 ? (
                  <div className="an-priority__list" data-testid="priority-integrity-topics">
                    {data.topics.map((topic) => (
                      <div key={topic.anchorId} className="an-priority__row">
                        <div className="an-priority__row-title">
                          <span className={`an-priority__prio an-priority__prio--${topic.band}`}>
                            {topic.band}
                          </span>
                          <span>{topic.title}</span>
                        </div>
                        <span>
                          {formatCount(topic.deferred)} deferred ·{" "}
                          {formatDays(topic.postponeDebtDays)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="an-priority__empty">No topic-level priority debt.</p>
                )}
              </div>

              <div>
                <div className="an-priority__subhead">Postponed rows</div>
                {data.sacrificed.length > 0 ? (
                  <div className="an-priority__list" data-testid="priority-integrity-sacrificed">
                    {data.sacrificed.map((row) => (
                      <div key={row.id} className="an-priority__row">
                        <div className="an-priority__row-title">
                          <span className={`an-priority__prio an-priority__prio--${row.band}`}>
                            {row.band}
                          </span>
                          <span>{row.title}</span>
                        </div>
                        <span>
                          {row.postponeCount}x · {formatDays(row.postponeDebtDays)} ·{" "}
                          {row.scheduler}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="an-priority__empty">No deferred rows in this window.</p>
                )}
              </div>
            </div>
          </div>
        ) : error ? null : (
          <p className="an-loading">Loading priority integrity...</p>
        )}
      </section>
    );
  },
);
