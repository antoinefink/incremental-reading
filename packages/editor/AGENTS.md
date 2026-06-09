# AGENTS.md

`packages/editor` owns Tiptap/ProseMirror document structure, marks, stable block IDs,
serialization, source selection, and reader decorations.

Documents are lineage substrate, not display-only content. Preserve:

- stable block IDs
- highlight, extracted, processed, and cloze marks
- read-points
- source-location mappings
- parent/source references needed by extracts and cards

Extracts are independent scheduled elements, not highlights. Editor code may compute selections
and source locations, but durable creation happens through typed app APIs/local-db services.

Do not generate unstable block IDs during normal edits, serialization, or round trips. Tests must
cover block ID stability, mark preservation, selection offsets, jump-to-source behavior, and
serialization round trips for changed behavior.
