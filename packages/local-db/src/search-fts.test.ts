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
