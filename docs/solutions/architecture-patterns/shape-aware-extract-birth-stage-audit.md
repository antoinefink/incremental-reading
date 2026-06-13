---
title: "Shape-aware extract birth stages stay deterministic and auditable"
date: 2026-06-13
category: architecture-patterns
module: extraction-pipeline
problem_type: architecture_pattern
component: service_object
severity: medium
applies_when:
  - "Creating extracts from reader selections that may already be card-ready atomic statements."
  - "Classifying rich selections after reconstructing the selected ProseMirror body."
  - "Adding same-session conversion affordances without bypassing source lineage or operation-log boundaries."
tags: [extracts, birth-stage, source-lineage, operation-log, card-conversion]
---

# Shape-aware extract birth stages stay deterministic and auditable

## Context

T122 changed extraction from a fixed `raw_extract` birth stage to a conservative main-side
classifier. A selected definition, fact, or simple formula can now be born as an
`atomic_statement`, show a convert-now affordance, and become a card in the same session. Prose,
lists, code, media, and failed rich reconstruction still start raw.

The important boundary is that the renderer still never decides the stage. It asks to create an
extract from a selection; the desktop service reconstructs the body, classifies shape, persists the
stage, schedules attention return, writes source lineage, and logs the classifier evidence inside
the same extraction flow.

## Guidance

Put the classifier in a pure package, but invoke it only after the service has the canonical body
seed:

```ts
const conversion = richConversion ?? plainTextToProseMirrorDoc(input.selectedText);
const shapeClassification = classifyExtractShape({
  normalizedText: conversion.plainText,
  paragraphCount: countDocumentParagraphs(conversion.doc),
  blockCount: conversion.blocks.length,
  blockTypes: conversion.blocks.map((block) => block.blockType),
  hasList: docHasNodeType(conversion.doc, (type) => /list/i.test(type)),
  hasCode: docHasNodeType(conversion.doc, (type) => /code/i.test(type)),
  hasMath: docHasNodeType(conversion.doc, (type) => type === "math"),
  hasMedia: docHasNodeType(conversion.doc, (type) => /image|video|audio/i.test(type)),
  rich: richConversion != null,
  fallback: richReconstructionFailed,
  reconstructionFailed: richReconstructionFailed,
});
```

Treat failed rich reconstruction differently from intentional plain-text capture. Offsetless text
selections, including PDF text extraction, can still be classified from their text shape. Failed
rich reconstruction should fail closed because the service knows it could not rebuild the selected
document shape.

Persist text-free audit evidence with the existing `create_extract` operation-log payload. The
result should include classifier version, classification, chosen stage, reason codes, input stats,
structural flags, and a deterministic normalized-input hash. Do not store duplicate selected body
text in the classifier payload; the extract document and source location already own text.

Expose the same text-free classifier summary on the extraction create result. UI callers mostly
need `extract.stage`, but agents and other typed clients should not need raw SQL to explain why an
extract was born raw or atomic.

Route convert-now through normal card creation. The prompt should navigate to the extract with a
one-shot builder intent, wait for the extract document to load before mounting the card builder, and
clear stale prompts when later raw extractions occur. A convert-now prompt is an affordance, not a
new persistence path.

## Why This Matters

Birth-stage classification is attractive because it removes queue load: a card-ready statement no
longer needs multiple scheduled distillation touches before the user can create a card. But if the
renderer decided the stage, or if classifier evidence lived only in transient UI state, the feature
would erode Interleave's source-lineage and command-shaped mutation invariants.

The deterministic-service pattern keeps the shortcut honest. Atomic-born extracts still have source
locations, operation-log evidence, attention scheduling, and reversible stage correction. Raw prose
keeps the old ladder, while card-ready captures can be drained immediately.

## When to Apply

- Selection-to-element commands where the created element can safely skip an early lifecycle stage.
- Heuristics that depend on reconstructed rich document shape rather than renderer text alone.
- UI shortcuts that should accelerate a normal command path without creating a second mutation path.
- Agent-facing workflows that need typed audit metadata without direct database access.

## Examples

Good operation-log payload shape:

```ts
{
  type: "create_extract",
  sourceElementId,
  locationSourceElementId,
  shapeClassification: {
    heuristicVersion: "extract-shape.v1",
    classification: "atomic_ready",
    stage: "atomic_statement",
    reasonCodes: ["single_atomic_statement"],
    stats: { wordCount: 7, sentenceCount: 1, paragraphCount: 1, blockCount: 1 },
    inputSignals: { rich: true, fallback: false, reconstructionFailed: false },
    normalizedInputHash: "fnv1a32:..."
  }
}
```

Good UI route handling:

```ts
if (search.cardBuilder === "qa" && doc.status === "ready") {
  setBuilder({ tab: "qa" });
  navigate({ to: "/extract/$id", params: { id }, search: {}, replace: true });
}
```

The route intent is consumed only after the document is ready, so the card builder seeds from the
current extract body instead of an empty or previous body.

## Related

- [Rich extractions preserve paragraphs and images](../logic-errors/rich-extractions-preserve-paragraphs-and-images.md)
- [Frozen conversion sessions revalidate before every mutation](./frozen-conversion-session-revalidation.md)
- [Extract/card IPC invariant test hardening](./extract-card-ipc-invariant-test-hardening.md)
