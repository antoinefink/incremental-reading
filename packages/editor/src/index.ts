/**
 * @interleave/editor — Tiptap/ProseMirror extensions and extraction commands.
 *
 * Documents are the substrate for extraction lineage, not just display: this
 * package owns stable block IDs, highlight / extracted-span / processed-span /
 * cloze marks, and the extraction commands (T015+). Nothing is implemented yet —
 * this trivial export only proves the package resolves across the workspace.
 */
export const EDITOR_PACKAGE = "@interleave/editor" as const;

/** Placeholder until the editor extensions are defined in T015+. */
export const editorPlaceholder = (): string => EDITOR_PACKAGE;
