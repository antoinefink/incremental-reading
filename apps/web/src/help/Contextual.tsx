/**
 * Contextual help primitives (design handoff — "Incremental Reading.html").
 *
 *   HelpLink   — a compact "?" dot or inline "Learn more →" that deep-links into
 *                the help center (by slug).
 *   InlineHint — always-present small helper text, optionally with a HelpLink.
 *   Coachmark  — an anchored callout (tour step or one-off), with an optional
 *                spotlight backdrop that dims the page and rings the target.
 *   OnceCoach  — a Coachmark gated on the tips toggle + the once-only seen set.
 *
 * These are the "help linked to throughout the app" surface. They are
 * presentation-only and read the imperative entry points from `useHelp()`.
 */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { useHelp } from "./HelpContext";
import { cx } from "./primitives";
import "./help.css";

/* ----------------------------- HelpLink ----------------------------- */

export function HelpLink({
  slug,
  variant = "dot",
  children,
  title,
}: {
  slug?: string;
  variant?: "dot" | "inline";
  children?: ReactNode;
  title?: string;
}) {
  const { openHelp } = useHelp();
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    openHelp(slug);
  };
  if (variant === "inline") {
    return (
      <button type="button" className="help-inline" onClick={onClick}>
        {children || "Learn more"}
        <Icon name="chevronRight" size={12} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="help-dot"
      onClick={onClick}
      title={title || "Open help"}
      aria-label="Open help"
    >
      ?
    </button>
  );
}

/* ----------------------------- InlineHint ----------------------------- */

export function InlineHint({
  icon = "info",
  children,
  slug,
  slugLabel,
  warn,
}: {
  icon?: IconName;
  children: ReactNode;
  slug?: string;
  slugLabel?: string;
  warn?: boolean;
}) {
  return (
    <div className={cx("inline-hint", warn && "inline-hint--warn")}>
      <Icon name={icon} size={13} />
      <span>
        {children}
        {slug && (
          <>
            {" "}
            <HelpLink slug={slug} variant="inline">
              {slugLabel || "Learn more"}
            </HelpLink>
          </>
        )}
      </span>
    </div>
  );
}

/* -------------------- anchor measurement (for coachmarks) -------------------- */

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

/**
 * Track the on-screen rect of `sel` while `active`. Retries (rAF, then a slow
 * interval) until the target mounts, and re-measures on scroll/resize so the
 * coachmark stays glued to a moving control.
 */
export function useAnchorRect(sel: string | null | undefined, active: boolean): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!active || !sel) {
      setRect(null);
      return;
    }
    let raf = 0;
    let tries = 0;
    const measure = (): boolean => {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width || r.height) {
          setRect({
            top: r.top,
            left: r.left,
            width: r.width,
            height: r.height,
            bottom: r.bottom,
            right: r.right,
          });
          return true;
        }
      }
      return false;
    };
    const tick = () => {
      if (!measure() && tries++ < 40) raf = requestAnimationFrame(tick);
    };
    tick();
    const iv = window.setInterval(measure, 250);
    const onWin = () => measure();
    window.addEventListener("resize", onWin, true);
    window.addEventListener("scroll", onWin, true);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(iv);
      window.removeEventListener("resize", onWin, true);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [sel, active]);
  return rect;
}

/* ----------------------------- Coachmark ----------------------------- */

export type Placement = "top" | "bottom" | "left" | "right" | "center";

export interface CoachmarkProps {
  targetSel?: string | null;
  placement?: Placement;
  backdrop?: boolean;
  lg?: boolean;
  icon?: IconName;
  eyebrow?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  demo?: ReactNode;
  slug?: string;
  /** Tour mode: when `step` is set, render the dots + Back/Next footer. */
  step?: number;
  total?: number;
  onNext?: () => void;
  nextLabel?: string;
  onPrev?: () => void;
  onDismiss?: () => void;
}

export function Coachmark({
  targetSel,
  placement = "bottom",
  backdrop,
  lg,
  icon = "sparkle",
  eyebrow,
  title,
  children,
  demo,
  slug,
  step,
  total,
  onNext,
  nextLabel,
  onPrev,
  onDismiss,
}: CoachmarkProps) {
  const rect = useAnchorRect(targetSel, true);
  const cardRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: lg ? 360 : 312, h: 200 });

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSize((prev) =>
      Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
        ? prev
        : { w: r.width, h: r.height },
    );
  });

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 14;
  const pad = 12;
  const centered = !targetSel || placement === "center" || (Boolean(targetSel) && !rect);

  let pos: { top: number; left: number };

  if (centered || !rect) {
    pos = { top: Math.max(pad, vh / 2 - size.h / 2 - 20), left: vw / 2 - size.w / 2 };
  } else {
    const acx = rect.left + rect.width / 2;
    const acy = rect.top + rect.height / 2;
    let top: number;
    let left: number;
    if (placement === "top") {
      top = rect.top - gap - size.h;
      left = acx - size.w / 2;
    } else if (placement === "right") {
      left = rect.right + gap;
      top = acy - size.h / 2;
    } else if (placement === "left") {
      left = rect.left - gap - size.w;
      top = acy - size.h / 2;
    } else {
      top = rect.bottom + gap;
      left = acx - size.w / 2;
    }
    left = Math.min(Math.max(pad, left), vw - size.w - pad);
    top = Math.min(Math.max(pad, top), vh - size.h - pad);
    pos = { top, left };
  }

  const spot =
    backdrop && rect && !centered
      ? {
          top: rect.top - 6,
          left: rect.left - 6,
          width: rect.width + 12,
          height: rect.height + 12,
        }
      : null;
  const isTour = step != null && total != null;

  return (
    <>
      {backdrop && <div className="coach-backdrop" />}
      {spot && <div className="coach-spot" style={spot} />}
      <div
        className={cx("coach", lg && "coach--lg")}
        ref={cardRef}
        style={{ top: pos.top, left: pos.left }}
        role="dialog"
        aria-label={typeof title === "string" ? title : "Tip"}
      >
        <div className="coach__top">
          <span className="coach__icon">
            <Icon name={icon} size={15} />
          </span>
          <div className="col" style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {eyebrow && <span className="coach__eyebrow">{eyebrow}</span>}
            <span className="coach__title">{title}</span>
          </div>
          {onDismiss && (
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--icon coach__close"
              onClick={onDismiss}
              aria-label="Dismiss"
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
        <div className="coach__body">{children}</div>
        {demo}
        <div className="coach__foot">
          {isTour ? (
            <>
              <div className="coach__dots grow">
                {Array.from({ length: total }).map((_, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: static dot row
                    key={i}
                    className={cx("coach__dot", i === step && "coach__dot--on")}
                  />
                ))}
              </div>
              {onPrev && step > 0 && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={onPrev}>
                  Back
                </button>
              )}
              <button type="button" className="btn btn--primary btn--sm" onClick={onNext}>
                {nextLabel || (step === total - 1 ? "Finish" : "Next")}
              </button>
            </>
          ) : (
            <>
              {slug ? (
                <span className="grow">
                  <HelpLink slug={slug} variant="inline">
                    Learn more
                  </HelpLink>
                </span>
              ) : (
                <span className="grow" />
              )}
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={onNext || onDismiss}
              >
                {nextLabel || "Got it"}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * A once-only contextual coachmark: renders nothing if tips are disabled or the
 * id has already been seen; dismissing (or "Got it") marks it seen for good.
 */
export function OnceCoach({
  id,
  onNext,
  ...props
}: { id: string } & Omit<CoachmarkProps, "onDismiss">) {
  const { tipsEnabled, isSeen, markSeen } = useHelp();
  if (!tipsEnabled || isSeen(id)) return null;
  return (
    <Coachmark
      {...props}
      onDismiss={() => markSeen(id)}
      onNext={
        onNext
          ? () => {
              markSeen(id);
              onNext();
            }
          : () => markSeen(id)
      }
    />
  );
}
