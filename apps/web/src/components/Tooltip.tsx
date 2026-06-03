/**
 * Tooltip — a small, instant, styled hover/focus bubble for icon-only controls.
 *
 * The queue's per-row action cluster (and other icon-only toolbars) previously
 * leaned on the native `title` attribute, whose OS tooltip is slow (~1.5s) and
 * unstyled. This renders a calm, immediate, design-token bubble instead.
 *
 * It is **portaled to `document.body`** and positioned from the trigger's
 * bounding rect, so it is never clipped by an ancestor's `overflow` — the queue
 * list virtualizes inside an `overflow:auto` scroll container, where a pure-CSS
 * `::after` bubble WOULD be cut off. The bubble re-measures on scroll/resize so
 * it tracks the trigger.
 *
 * Accessibility: the wrapped control keeps its own `aria-label` (the accessible
 * NAME of an icon-only button); the visual bubble is `aria-hidden` so a screen
 * reader is not told the same words twice. It shows on pointer hover AND on
 * keyboard focus, and hides on blur / mouse-leave / Escape. Pure UI — no domain
 * logic, design tokens only.
 */

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./tooltip.css";

interface BubblePos {
  readonly left: number;
  readonly top: number;
}

/** Keep the bubble this far from the trigger and the viewport edges (px). */
const GAP = 6;
const VIEWPORT_MARGIN = 8;

export function Tooltip({
  label,
  children,
  disabled,
}: {
  /** Text shown in the bubble (typically mirrors the trigger's `aria-label`). */
  readonly label: string;
  /** Exactly one hoverable/focusable trigger (e.g. a `<button>`). */
  readonly children: ReactNode;
  /** Suppress the bubble (e.g. while a menu the trigger owns is open). */
  readonly disabled?: boolean;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  // `null` = not yet measured this open cycle; the bubble renders off-screen
  // until `useLayoutEffect` measures it (so the un-positioned frame never paints).
  const [pos, setPos] = useState<BubblePos | null>(null);

  const show = useCallback(() => {
    if (!disabled) setOpen(true);
  }, [disabled]);
  const hide = useCallback(() => setOpen(false), []);

  // Place the bubble centered ABOVE the trigger, clamped to the viewport so an
  // edge button can't push it off-screen. Measured after paint so the bubble's
  // own width/height is known before we position it.
  const position = useCallback(() => {
    const trigger = wrapRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const t = trigger.getBoundingClientRect();
    // If the trigger has scrolled fully out of view, close rather than pin a stale
    // bubble to the viewport edge labeling an invisible control. Strict inequalities
    // keep an edge-aligned (or zero-rect, e.g. jsdom) trigger considered visible.
    if (t.bottom < 0 || t.top > window.innerHeight || t.right < 0 || t.left > window.innerWidth) {
      setOpen(false);
      return;
    }
    const b = bubble.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(t.left + t.width / 2 - b.width / 2, window.innerWidth - b.width - VIEWPORT_MARGIN),
    );
    const top = Math.max(VIEWPORT_MARGIN, t.top - b.height - GAP);
    setPos({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open || disabled) {
      setPos(null);
      return;
    }
    position();
  }, [open, disabled, position]);

  // While open: re-measure on scroll/resize (the trigger moves, the portaled
  // bubble doesn't), and close on Escape. `scroll` is captured so the inner
  // virtualized queue list's own scrolling is caught, not just the window's.
  useEffect(() => {
    if (!open || disabled) return;
    const onScrollOrResize = () => position();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, disabled, position]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only OBSERVES hover/focus to position the tooltip; the interactive control is the wrapped child, which keeps its own role + aria-label.
    <span
      ref={wrapRef}
      className="tt"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {open && !disabled
        ? createPortal(
            <span
              ref={bubbleRef}
              // No `role="tooltip"`: the bubble is purely visual and `aria-hidden`,
              // so the accessible name comes from the wrapped control's own
              // `aria-label` — a tooltip role on a hidden node would be dead markup.
              aria-hidden="true"
              className="tt__bubble"
              data-testid="tooltip"
              style={
                pos
                  ? { left: pos.left, top: pos.top }
                  : // Pre-measurement: fully hidden (but still measurable) and
                    // off-screen, so no unplaced or half-animated frame is ever
                    // painted (useLayoutEffect positions it before paint).
                    { left: -9999, top: -9999, visibility: "hidden" }
              }
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
