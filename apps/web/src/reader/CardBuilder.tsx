/**
 * Card builder (T033 — Q&A card creation; T034 — cloze card creation).
 *
 * The RIGHT column of `design/kit/app/screen-builder.jsx`, rebuilt for our stack.
 * From the extract distillation workspace ({@link ExtractView}) the user opens this
 * panel and authors a card:
 *
 *  - the `Cloze` / `Q&A` tabs (Image occlusion stays disabled — M15);
 *  - the Q&A `Front · question` + `Back · answer` textareas;
 *  - the Cloze `Cloze text` textarea — wrap answers in `{{ }}`; the preview renders
 *    each deletion as `[ … ]` and reveals the answers on toggle, driven by the
 *    `@interleave/core` `renderClozePrompt` helper (NOT ad-hoc regex here);
 *  - a live `cardprev` preview that shows the front and toggles to the back / reveals
 *    cloze answers (Space, mirroring the kit's `Kbd ␣`);
 *  - the `qc` quality-checklist CONTAINER (the heuristics land in T035 — this task
 *    renders the shell only);
 *  - the A/B/C/D priority chips (default = the extract's label) + the FSRS
 *    `SchedulerChip` (FSRS side; schedule values are previews/`—` until M7);
 *  - a `Create Q&A card` / `Create cloze card` block button.
 *
 * Pressing Create calls the typed `cards.create` command (T032) — the renderer
 * ships ONLY the authored strings + the `extractId` + the chosen priority label.
 * For a cloze card the renderer canonicalizes the `{{ }}` text to the numbered
 * `{{c1::answer}}` form via `@interleave/core` before sending it (the main side
 * re-canonicalizes + derives the structured metadata + persists the `cloze`
 * document_marks; the renderer never touches SQL). All lineage/priority/tag
 * inheritance happens main-side in `CardService`; this component is presentational —
 * NO SQL, NO priority-numeric math, NO lineage resolution, NO cloze parsing logic of
 * its own (Architectural rules). On success the builder stays open and threads the
 * returned `siblingGroupId` so a Q&A + cloze pair (or a multi-cloze set) can be
 * authored back-to-back as siblings.
 *
 * The card is created at `card_draft` with an UN-DUE `review_states` row (M6 does
 * no FSRS math); it appears in the inspector + lineage tree immediately and enters
 * FSRS rotation in M7.
 */

import { canonicalizeCloze, parseCloze, renderClozePrompt } from "@interleave/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { priorityLabel } from "../components/inspector/primitives";
import { appApi, type CardKind, type PriorityLabel } from "../lib/appApi";

/** The builder's two enabled tabs (Image occlusion is M15, disabled). */
type BuilderTab = CardKind;

const PRIORITY_LABELS: readonly PriorityLabel[] = ["A", "B", "C", "D"];

export interface CardBuilderProps {
  /** The originating extract id — the only id the renderer ships to `cards.create`. */
  readonly extractId: string;
  /** The extract's numeric priority — the default A/B/C/D chip selection. */
  readonly extractPriority: number;
  /**
   * Seed text for the answer / cloze body (usually the extract's atomic
   * statement). The user edits both fields freely from here.
   */
  readonly seedBody?: string;
  /** The tab to open on (Q&A by default; the Cloze toolbar action opens `cloze`). */
  readonly initialTab?: BuilderTab;
  /** Pre-wrapped cloze text (T034 — the selection wrapped as `{{c1::…}}`). */
  readonly initialClozeText?: string;
  /** Surface a transient status message (reuses the host view's toast). */
  readonly onToast: (message: string) => void;
  /** Re-fetch the inspector + lineage so the new card appears under the extract. */
  readonly onCardCreated: () => void;
  /** Close the builder column (returns to the two-column distill surface). */
  readonly onClose: () => void;
}

/**
 * Author a card from an extract. Both tabs are fully wired: Q&A (T033) and Cloze
 * (T034 — `{{ }}` authoring, `[ … ]` preview + reveal, canonical numbered send).
 */
export function CardBuilder({
  extractId,
  extractPriority,
  seedBody,
  initialTab = "qa",
  initialClozeText,
  onToast,
  onCardCreated,
  onClose,
}: CardBuilderProps) {
  const defaultLabel = priorityLabel(extractPriority);

  const [tab, setTab] = useState<BuilderTab>(initialTab);
  const [front, setFront] = useState("");
  const [back, setBack] = useState(seedBody?.trim() ?? "");
  const [cloze, setCloze] = useState(initialClozeText ?? seedBody?.trim() ?? "");
  const [priority, setPriority] = useState<PriorityLabel>(defaultLabel);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The sibling group the FIRST card from this extract minted; threaded into the
  // next create so a Q&A + cloze pair are recorded as siblings.
  const [siblingGroupId, setSiblingGroupId] = useState<string | undefined>(undefined);

  // When the host re-seeds the builder (a new extract / a Cloze-toolbar open), pick
  // up the new tab + cloze pre-wrap without remounting.
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  useEffect(() => {
    if (initialClozeText !== undefined) setCloze(initialClozeText);
  }, [initialClozeText]);

  // Reset the priority chip to the extract's band when the extract changes.
  useEffect(() => {
    setPriority(defaultLabel);
  }, [defaultLabel]);

  const qaValid = front.trim().length > 0 && back.trim().length > 0;
  // A cloze is authorable once it has at least one deletion (a coarse boundary — the
  // rich quality gate is T035). `clozeCount` is computed below; reference it lazily.
  const canCreate = tab === "qa" ? qaValid : parseCloze(cloze).clozeCount > 0;

  // The Q&A preview face: front, toggling to back on reveal.
  const previewFace = useMemo(() => {
    return revealed ? back : front;
  }, [revealed, front, back]);

  // The cloze preview spans (T034): each `{{cN::…}}` renders as `[ … ]` and reveals
  // its answer on toggle, via the core helper — no ad-hoc regex in the component. The
  // distinct-deletion count drives the "Create cloze card" affordance + (later) T035.
  const clozeSpans = useMemo(
    () => renderClozePrompt(cloze, { revealAll: revealed }),
    [cloze, revealed],
  );
  const clozeCount = useMemo(() => parseCloze(cloze).clozeCount, [cloze]);

  const toggleReveal = useCallback(() => setRevealed((r) => !r), []);

  // Space toggles the preview reveal on BOTH tabs (mirrors the kit's `Kbd ␣`), but
  // only when the user is NOT typing into a field — a bare Space inside a textarea
  // must type a space. Bound once; the handler reads no render-scoped state.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space" && e.key !== " ") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      e.preventDefault();
      setRevealed((r) => !r);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const create = useCallback(async () => {
    if (!canCreate || busy) return;
    setBusy(true);
    try {
      const result = await appApi.createCard({
        extractId,
        kind: tab,
        priority,
        ...(siblingGroupId ? { siblingGroupId } : {}),
        ...(tab === "qa"
          ? { prompt: front.trim(), answer: back.trim() }
          : // Canonicalize `{{ }}` → numbered `{{c1::…}}` before sending so the
            // stored `cards.cloze` is always canonical (the main side re-canonicalizes
            // and derives the structured metadata + `cloze` document_marks).
            { cloze: canonicalizeCloze(cloze) }),
      });
      // Thread the (minted/reused) group so the next card from this extract is a sibling.
      setSiblingGroupId(result.card.siblingGroupId);
      onToast(tab === "qa" ? "Q&A card created" : "Cloze card created");
      onCardCreated();
      // Leave the builder ready for another card: keep the body context, clear the
      // authored prompt so the user does not accidentally re-create the same card.
      if (tab === "qa") {
        setFront("");
      }
      setRevealed(false);
    } catch {
      onToast("Could not create card");
    } finally {
      setBusy(false);
    }
  }, [
    canCreate,
    busy,
    extractId,
    tab,
    priority,
    siblingGroupId,
    front,
    back,
    cloze,
    onToast,
    onCardCreated,
  ]);

  return (
    <aside className="card-builder" data-testid="card-builder">
      <div className="card-builder__tabs" role="tablist" aria-label="Card type">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "qa"}
          className="cb-tab"
          data-on={tab === "qa" ? "true" : "false"}
          data-testid="cb-tab-qa"
          onClick={() => setTab("qa")}
        >
          Q&amp;A
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "cloze"}
          className="cb-tab"
          data-on={tab === "cloze" ? "true" : "false"}
          data-testid="cb-tab-cloze"
          onClick={() => setTab("cloze")}
        >
          Cloze
        </button>
        <button
          type="button"
          className="cb-tab cb-tab--disabled"
          disabled
          title="Coming later"
          aria-disabled="true"
        >
          Image occlusion
        </button>
        <button
          type="button"
          className="cb-tab cb-tab--close"
          aria-label="Close card builder"
          data-testid="cb-close"
          onClick={onClose}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="card-builder__body">
        {tab === "qa" ? (
          <>
            <div className="cb-field">
              <label className="cb-field__label" htmlFor="cb-qa-front">
                Front · question
              </label>
              <textarea
                id="cb-qa-front"
                className="cb-textarea"
                rows={2}
                data-testid="cb-qa-front"
                value={front}
                onChange={(e) => setFront(e.target.value)}
                placeholder="Ask one clear, single-fact question…"
              />
            </div>
            <div className="cb-field">
              <label className="cb-field__label" htmlFor="cb-qa-back">
                Back · answer
              </label>
              <textarea
                id="cb-qa-back"
                className="cb-textarea"
                rows={2}
                data-testid="cb-qa-back"
                value={back}
                onChange={(e) => setBack(e.target.value)}
                placeholder="One atomic answer…"
              />
            </div>
            <div className="cb-preview">
              <div className="cardprev__label">Preview · {revealed ? "back" : "front"}</div>
              <div className="cardprev" data-testid="cb-preview">
                <div className="cardprev__face">
                  {previewFace.trim() ? previewFace : <span className="dimmed">—</span>}
                </div>
              </div>
              <button
                type="button"
                className="cb-reveal"
                data-testid="cb-reveal"
                onClick={toggleReveal}
              >
                <Icon name="eye" size={14} /> {revealed ? "Show front" : "Show back"}
                <kbd className="cb-kbd">␣</kbd>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="cb-field">
              <label className="cb-field__label" htmlFor="cb-cloze-text">
                Cloze text · wrap answers in {"{{ }}"}
              </label>
              <textarea
                id="cb-cloze-text"
                className="cb-textarea"
                rows={4}
                data-testid="cb-cloze-text"
                value={cloze}
                onChange={(e) => setCloze(e.target.value)}
                placeholder="Wrap each answer like {{c1::answer}}…"
              />
              <div className="cb-field__hint" data-testid="cb-cloze-count">
                {clozeCount === 0
                  ? "No cloze deletion yet — wrap a phrase in {{ }}"
                  : `${clozeCount} cloze deletion${clozeCount > 1 ? "s" : ""}`}
              </div>
            </div>
            <div className="cb-preview">
              <div className="cardprev__label">Preview · {revealed ? "answers" : "deletions"}</div>
              <div className="cardprev" data-testid="cb-preview">
                <div className="cardprev__face cardprev__face--cloze">
                  {clozeCount === 0 ? (
                    <span className="dimmed">—</span>
                  ) : (
                    clozeSpans.map((span, i) =>
                      span.kind === "deletion" ? (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
                          key={i}
                          className={`cloze${span.revealed ? " cloze--revealed" : ""}`}
                          data-testid="cb-cloze-deletion"
                        >
                          {span.content}
                        </span>
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
                        <span key={i}>{span.content}</span>
                      ),
                    )
                  )}
                </div>
              </div>
              <button
                type="button"
                className="cb-reveal"
                data-testid="cb-reveal"
                onClick={toggleReveal}
              >
                <Icon name="eye" size={14} /> {revealed ? "Hide answers" : "Reveal answers"}
                <kbd className="cb-kbd">␣</kbd>
              </button>
            </div>
          </>
        )}

        {/* Quality checks — the container; the heuristics + rows land in T035. */}
        <div className="insp-sec cb-quality" data-testid="cb-quality">
          <div className="insp-sec__title">Quality checks</div>
          <div className="cb-quality__rows">
            <div className="dimmed cb-quality__pending">
              Quality checks land with the next step.
            </div>
          </div>
        </div>

        {/* Priority & schedule — A/B/C/D chips + the FSRS preview chip. */}
        <div className="insp-sec cb-schedule">
          <div className="insp-sec__title">Priority &amp; schedule</div>
          <div className="cb-prio-row" data-testid="cb-priority">
            {PRIORITY_LABELS.map((p) => (
              <button
                key={p}
                type="button"
                className="cb-prio-chip"
                data-active={priority === p ? "true" : "false"}
                data-testid={`cb-priority-${p}`}
                onClick={() => setPriority(p)}
              >
                <span className={`prio-dot prio-dot--${p.toLowerCase()}`} />
                {p}
              </button>
            ))}
          </div>
          <div className="cb-meta">
            <div className="cb-meta__row">
              <span className="cb-meta__k">First due</span>
              <span className="cb-meta__v">— (M7)</span>
            </div>
            <div className="cb-meta__row">
              <span className="cb-meta__k">Scheduler</span>
              <span className="cb-meta__v">
                <span className="sched sched--fsrs" data-testid="cb-scheduler-fsrs">
                  <Icon name="brain" size={12} /> FSRS
                </span>
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          className="cb-create"
          data-testid="cb-create"
          disabled={!canCreate || busy}
          onClick={() => void create()}
        >
          <Icon name="card" size={14} /> Create {tab === "qa" ? "Q&A" : "cloze"} card
        </button>
      </div>
    </aside>
  );
}
