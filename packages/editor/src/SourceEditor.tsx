/**
 * The React Tiptap editor for a source body (T015).
 *
 * This is the only React-aware module in `@interleave/editor`: it wraps the
 * constrained schema ({@link interleaveExtensions}) in `@tiptap/react`'s
 * `useEditor`/`EditorContent`. The schema, serialization, and (later) block-ID
 * logic stay in framework-agnostic siblings so they remain unit-testable without
 * a DOM and reusable outside React.
 *
 * Props:
 *  - `initialDoc`  — the ProseMirror JSON to load (or `undefined` → empty doc).
 *  - `editable`    — whether the user can type; the reader (T018) defaults this
 *                    to read-leaning, but editing in place is supported.
 *  - `onChange`    — debounced emitter of `{ prosemirrorJson, plainText }`; the
 *                    renderer's `useDocument` hook persists it via
 *                    `documents.save`. `plainText` is computed here with the
 *                    shared {@link toPlainText} so the stored mirror matches.
 *
 * Styling is class-based (`.reader` faces from the app stylesheet, derived from
 * the design tokens) — this component hard-codes no colors or pixel values.
 */

import type { Content } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import { interleaveExtensions } from "./schema";
import { emptyDoc, toPlainText } from "./serialize";

/** The payload emitted on every (debounced) document change. */
export interface SourceEditorChange {
  /** The current ProseMirror document JSON. */
  readonly prosemirrorJson: unknown;
  /** The flattened plain-text mirror (kept in sync via {@link toPlainText}). */
  readonly plainText: string;
}

export interface SourceEditorProps {
  /** Initial ProseMirror JSON; `undefined` loads an empty single-paragraph doc. */
  readonly initialDoc?: unknown;
  /** Whether the editor accepts input. Defaults to `true`. */
  readonly editable?: boolean;
  /** Debounced change emitter. */
  readonly onChange?: (change: SourceEditorChange) => void;
  /** Debounce window for `onChange`, in ms. Defaults to 400. */
  readonly debounceMs?: number;
  /** Optional extra class on the editor surface (composed with `.reader`). */
  readonly className?: string;
}

/**
 * The constrained rich-text editor. Renders into a `.reader` surface so it
 * inherits the serif read face + spacing from the app stylesheet.
 */
export function SourceEditor({
  initialDoc,
  editable = true,
  onChange,
  debounceMs = 400,
  className,
}: SourceEditorProps): React.ReactElement {
  // Keep the latest onChange without re-creating the editor when it changes.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const debounceRef = useRef(debounceMs);
  debounceRef.current = debounceMs;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: interleaveExtensions,
    // `initialDoc` is ProseMirror JSON (or empty when absent); fall back to a
    // single empty paragraph so the editor always has valid content.
    content: ((initialDoc as Content | null | undefined) ?? emptyDoc()) as Content,
    editable,
    // The renderer owns persistence; the editor never reaches the DB.
    onUpdate: ({ editor: instance }) => {
      const emit = onChangeRef.current;
      if (!emit) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const json = instance.getJSON();
        emit({ prosemirrorJson: json, plainText: toPlainText(json) });
      }, debounceRef.current);
    },
  });

  // Reflect `editable` changes without rebuilding the editor.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  // Flush any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const surfaceClass = className ? `reader ${className}` : "reader";
  return <EditorContent editor={editor} className={surfaceClass} />;
}
