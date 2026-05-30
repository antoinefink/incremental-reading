/**
 * SearchRepository FTS5 tests (T042).
 *
 * Run against a fresh in-memory `better-sqlite3` with ALL migrations applied
 * (`createInMemoryDb` → the `0002_search_fts5` migration creates the FTS tables +
 * triggers). These prove: ranking (title > body), card prompt matches, tag-only
 * matches, soft-delete exclusion, the empty/malformed query → `[]` contract, and
 * that the triggers keep the index in sync across insert/update/delete.
 */

import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ReviewRepository } from "./review-repository";
import { SearchRepository, toMatchExpression } from "./search-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

describe("SearchRepository (FTS5, T042)", () => {
  let handle: DbHandle;
  let search: SearchRepository;
  let sources: SourceRepository;
  let documents: DocumentRepository;
  let elementsRepo: ElementRepository;
  let review: ReviewRepository;

  beforeEach(() => {
    handle = createInMemoryDb();
    search = new SearchRepository(handle.db);
    sources = new SourceRepository(handle.db);
    documents = new DocumentRepository(handle.db);
    elementsRepo = new ElementRepository(handle.db);
    review = new ReviewRepository(handle.db);
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  /** Seed a source whose TITLE has the term and an extract whose BODY merely mentions it. */
  function seedTitleVsBody() {
    const { element: titled } = sources.create({ title: "Memory consolidation", priority: 0.5 });
    documents.upsert({
      elementId: titled.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "Sleep helps the brain file away the day's events.",
    });
    const { element: src2 } = sources.create({ title: "Sleep and the brain", priority: 0.5 });
    documents.upsert({
      elementId: src2.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "The hippocampus replays patterns and shifts memory into the cortex overnight.",
    });
    return { titled, src2 };
  }

  it("ranks a title match above a body-only match", () => {
    const { titled, src2 } = seedTitleVsBody();
    const hits = search.search("memory");
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(titled.id);
    expect(ids).toContain(src2.id);
    // The title hit must outrank the body-only hit.
    expect(ids.indexOf(titled.id)).toBeLessThan(ids.indexOf(src2.id));
  });

  it("ranks title-weighted within the same tier (bm25 weights, not just the tier)", () => {
    // Both sources mention the term in BOTH title and body, so both land in the
    // headline tier (tier 0); ordering is then the bm25 tiebreaker. With the
    // weights positional over ALL columns (element_id, title, body, tags), a
    // STRONGER title match must still outrank a weaker-title/stronger-body match.
    // Off-by-one weights (title landing on the UNINDEXED element_id) would invert
    // this, so the test pins the within-tier order, not just the coarse tier.
    const { element: strongTitle } = sources.create({
      title: "Memory memory memory",
      priority: 0.5,
    });
    documents.upsert({
      elementId: strongTitle.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "memory mentioned once in the body here",
    });
    const { element: strongBody } = sources.create({ title: "Memory once", priority: 0.5 });
    documents.upsert({
      elementId: strongBody.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "memory memory memory memory saturates this body text",
    });
    const ids = search.search("memory").map((h) => h.id);
    expect(ids).toContain(strongTitle.id);
    expect(ids).toContain(strongBody.id);
    // The title-heavy source must rank ahead of the body-heavy one.
    expect(ids.indexOf(strongTitle.id)).toBeLessThan(ids.indexOf(strongBody.id));
  });

  it("returns a card whose prompt matches a card query", () => {
    const { element: src } = sources.create({ title: "Host source", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "host body",
    });
    const card = review.createCard({
      sourceId: src.id,
      title: "card el",
      kind: "qa",
      prompt: "What is photosynthesis?",
      answer: "How plants convert light to energy.",
      priority: 0.5,
    });
    const hits = search.search("photosynthesis");
    expect(hits.map((h) => h.id)).toContain(card.element.id);
    expect(hits.find((h) => h.id === card.element.id)?.type).toBe("card");
  });

  it("a card hit's snippet is the prompt/answer text, NOT the element id", () => {
    // Regression: `snippet(card_fts, 0, …)` returns column 0 (element_id
    // UNINDEXED) — i.e. the ULID — instead of an excerpt of the matched field.
    // `snippet(card_fts, -1, …)` uses the best-matching column, so a prompt hit
    // excerpts the prompt and an answer-only hit excerpts the answer.
    const { element: src } = sources.create({ title: "Snippet host", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "host body",
    });
    const card = review.createCard({
      sourceId: src.id,
      title: "snippet card",
      kind: "qa",
      prompt: "What is photosynthesis in plants?",
      answer: "Chloroplasts convert sunlight into chemical energy.",
      priority: 0.5,
    });

    // A prompt hit excerpts the prompt — and must NEVER be the element id.
    const promptHit = search.search("photosynthesis").find((h) => h.id === card.element.id);
    expect(promptHit).toBeDefined();
    expect(promptHit?.snippet).not.toBe(card.element.id);
    expect(promptHit?.snippet.toLowerCase()).toContain("photosynthesis");

    // An answer-only hit excerpts the answer (still not the id).
    const answerHit = search.search("chloroplasts").find((h) => h.id === card.element.id);
    expect(answerHit).toBeDefined();
    expect(answerHit?.snippet).not.toBe(card.element.id);
    expect(answerHit?.snippet.toLowerCase()).toContain("chloroplast");
  });

  it("finds a tag-only match (the term appears only as a tag)", () => {
    const { element: src } = sources.create({ title: "Untagged title", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "no special words here",
    });
    elementsRepo.addTag(src.id, "neuroscience");
    const hits = search.search("neuroscience");
    expect(hits.map((h) => h.id)).toContain(src.id);
  });

  it("excludes soft-deleted elements", () => {
    const { element: src } = sources.create({ title: "Ephemeral memory", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "transient body",
    });
    expect(search.search("ephemeral").map((h) => h.id)).toContain(src.id);
    elementsRepo.softDelete(src.id);
    expect(search.search("ephemeral").map((h) => h.id)).not.toContain(src.id);
  });

  it("drops a soft-deleted CARD from search and clears its card_fts row", () => {
    // Regression: the `elements_fts_au` trigger rebuilt source_fts/extract_fts on
    // soft-delete but left card_fts untouched, so a soft-deleted card kept a stale
    // index row (masked only by the query join). Migration 0005 fixes the trigger.
    const { element: src } = sources.create({ title: "Card host", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "host body",
    });
    const card = review.createCard({
      sourceId: src.id,
      title: "ephemeral card",
      kind: "qa",
      prompt: "What is mitochondria?",
      answer: "The powerhouse of the cell.",
      priority: 0.5,
    });
    expect(search.search("mitochondria").map((h) => h.id)).toContain(card.element.id);

    elementsRepo.softDelete(card.element.id);

    // It leaves the search results entirely.
    expect(search.search("mitochondria").map((h) => h.id)).not.toContain(card.element.id);
    // And the trigger physically removed the card_fts row (no index drift).
    const remaining = handle.sqlite
      .prepare("SELECT element_id FROM card_fts WHERE element_id = ?")
      .all(card.element.id);
    expect(remaining).toHaveLength(0);
  });

  it("returns [] for an empty or whitespace-only query", () => {
    expect(search.search("")).toEqual([]);
    expect(search.search("   ")).toEqual([]);
    expect(search.query("   ")).toEqual([]);
  });

  it("degrades a malformed FTS query to [] instead of throwing", () => {
    seedTitleVsBody();
    // Pure FTS operators / punctuation — must not throw.
    expect(() => search.search('"')).not.toThrow();
    expect(() => search.search("AND OR NEAR( )")).not.toThrow();
    expect(search.search('"')).toEqual([]);
  });

  it("keeps the index in sync across insert / update / delete (the triggers work)", () => {
    // Insert: a source body containing "alpha".
    const { element: src } = sources.create({ title: "Greek letters", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "the first one is alpha",
    });
    expect(search.search("alpha").map((h) => h.id)).toContain(src.id);

    // Update: rewrite the body to "omega" — "alpha" must drop, "omega" appear.
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "the last one is omega",
    });
    expect(search.search("alpha").map((h) => h.id)).not.toContain(src.id);
    expect(search.search("omega").map((h) => h.id)).toContain(src.id);

    // Delete (hard): remove the document → the source drops from body matches, but
    // the title ("Greek letters") still resolves via the elements_fts trigger.
    handle.sqlite.prepare("DELETE FROM documents WHERE element_id = ?").run(src.id);
    expect(search.search("omega").map((h) => h.id)).not.toContain(src.id);
  });

  it("narrows by element type", () => {
    const { element: src } = sources.create({ title: "Quantum source", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "quantum body",
    });
    const card = review.createCard({
      sourceId: src.id,
      title: "card",
      kind: "qa",
      prompt: "quantum question?",
      answer: "answer",
      priority: 0.5,
    });
    expect(search.search("quantum", { type: "source" }).map((h) => h.id)).toEqual([src.id]);
    expect(search.search("quantum", { type: "card" }).map((h) => h.id)).toEqual([card.element.id]);
  });

  it("matches by prefix (typing the start of a word)", () => {
    const { element: src } = sources.create({ title: "Intelligence measure", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "body",
    });
    expect(search.search("intel").map((h) => h.id)).toContain(src.id);
  });

  describe("toMatchExpression", () => {
    it("builds a prefix-AND expression from words", () => {
      expect(toMatchExpression("hello world")).toBe('"hello"* AND "world"*');
    });
    it("strips FTS operators / punctuation", () => {
      expect(toMatchExpression("a-b: c(d)")).toBe('"a"* AND "b"* AND "c"* AND "d"*');
    });
    it("returns null for empty / operator-only input", () => {
      expect(toMatchExpression("   ")).toBeNull();
      expect(toMatchExpression('"()')).toBeNull();
    });
    it("escapes embedded quotes", () => {
      expect(toMatchExpression('say "hi"')).toBe('"say"* AND "hi"*');
    });
  });
});
