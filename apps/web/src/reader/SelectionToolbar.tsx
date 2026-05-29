/**
 * The floating text-selection toolbar (T019).
 *
 * Selecting any run of text in the reader pops this inline toolbar anchored above
 * the selection, offering the single entry point to every M4 action: **Extract**
 * (accent, `E`), **Cloze** (`C`), **Highlight** (`H`), **Copy**, and **Cancel**.
 * It rebuilds `design/kit/app/screen-reader.jsx`'s `SelToolbar` against the
 * canonical `.sel-toolbar` / `.sel-tool` tokens, positioned `fixed` above the
 * selection's bounding rect with `transform: translate(-50%, -100%)`.
 *
 * This component is PURELY PRESENTATIONAL — it holds no SQL, no lineage logic, no
 * selection state: it takes the resolved anchor position from the
 * {@link useTextSelection} hook and delegates each action to the callbacks the
 * reader passes in (which T020 wires to highlight, T021 to extract, M6 to the card
 * builder; `Copy`/`Cancel` are renderer-only). The critical interaction detail
 * (from the prototype) is `onMouseDown={preventDefault}` on the toolbar so
 * clicking a button never collapses the live ProseMirror selection (the marks are
 * applied through Tiptap commands, never DOM surgery — see the T019 risk note).
 */

import { Icon } from "../components/Icon";
import { Kbd } from "../shell/Kbd";

/** The action a toolbar button dispatches. */
export type SelectionToolbarAction = "extract" | "cloze" | "highlight" | "copy" | "cancel";

/** Where to anchor the toolbar: the top + horizontal-centre of the selection rect. */
export interface SelectionToolbarPosition {
  /** Viewport `top` (px) — the toolbar is translated up by 100% above this. */
  readonly top: number;
  /** Viewport `left` (px) — the toolbar is centred on this with translate(-50%). */
  readonly left: number;
}

export interface SelectionToolbarProps {
  /** The anchor position, or `null` to hide the toolbar entirely. */
  readonly position: SelectionToolbarPosition | null;
  /** Dispatch a toolbar action. The reader maps these to the M4 commands. */
  readonly onAction: (action: SelectionToolbarAction) => void;
}

/**
 * Render the floating selection toolbar, or nothing when `position` is null.
 *
 * `onMouseDown` is prevented on the container so pressing a button keeps the text
 * selection intact (the prototype's load-bearing trick) — the actual mark/extract
 * runs through Tiptap commands the action callbacks own, not here.
 */
export function SelectionToolbar({
  position,
  onAction,
}: SelectionToolbarProps): React.ReactElement | null {
  if (!position) return null;
  return (
    <div
      className="sel-toolbar fade-up"
      data-testid="selection-toolbar"
      role="toolbar"
      aria-label="Selection actions"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        transform: "translate(-50%, -100%)",
        zIndex: 80,
      }}
      // Keep the live ProseMirror selection alive when a button is pressed.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="sel-tool sel-tool--accent"
        data-testid="sel-tool-extract"
        onClick={() => onAction("extract")}
      >
        <Icon name="extract" size={14} /> Extract <Kbd keys="E" />
      </button>
      <button
        type="button"
        className="sel-tool"
        data-testid="sel-tool-cloze"
        onClick={() => onAction("cloze")}
      >
        <Icon name="cloze" size={14} /> Cloze <Kbd keys="C" />
      </button>
      <button
        type="button"
        className="sel-tool"
        data-testid="sel-tool-highlight"
        onClick={() => onAction("highlight")}
      >
        <Icon name="highlight" size={14} /> Highlight <Kbd keys="H" />
      </button>
      <span className="tool-div" aria-hidden />
      <button
        type="button"
        className="sel-tool"
        data-testid="sel-tool-copy"
        title="Copy selection"
        onClick={() => onAction("copy")}
      >
        <Icon name="copy" size={14} /> Copy
      </button>
      <button
        type="button"
        className="sel-tool"
        data-testid="sel-tool-cancel"
        title="Cancel (Esc)"
        aria-label="Cancel"
        onClick={() => onAction("cancel")}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
