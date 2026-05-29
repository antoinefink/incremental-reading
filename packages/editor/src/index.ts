/**
 * @interleave/editor — Tiptap/ProseMirror schema, serialization, and the React
 * source editor.
 *
 * Documents are the substrate for extraction lineage, not just display. This
 * package owns the **constrained** document schema (T015), the framework-
 * agnostic JSON↔plain-text helpers (T015), and — landing in later M3/M4 tasks —
 * stable block IDs, highlight / extracted-span / processed-span / cloze marks,
 * and the extraction commands. The schema + serialization stay React-free so
 * they are unit-testable without a DOM; only {@link SourceEditor} pulls in React.
 */

export const EDITOR_PACKAGE = "@interleave/editor" as const;

export {
  SourceEditor,
  type SourceEditorChange,
  type SourceEditorProps,
} from "./SourceEditor";
export {
  ALLOWED_HEADING_LEVELS,
  ALLOWED_MARK_NAMES,
  ALLOWED_NODE_NAMES,
  buildExtensions,
  buildSchema,
  interleaveExtensions,
} from "./schema";
export { emptyDoc, toPlainText } from "./serialize";
