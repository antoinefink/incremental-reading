/**
 * Anki transform tests (T070) — the PURE row⇄note + zip wrap/unwrap transforms.
 *
 * These exercise `@interleave/importers`'s `ankiRowsToNotes` / `notesToAnkiRows` /
 * `parseApkgZip` / `buildApkgZip` against fixture ROWS (the main-side service reads
 * the embedded SQLite via better-sqlite3 and hands the rows in) and an in-test built
 * `.apkg` zip — so no binary blob is committed.
 */

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  type AnkiCollectionRows,
  AnkiParseError,
  ankiRowsToNotes,
  buildApkgZip,
  type ExportNote,
  notesToAnkiRows,
  parseApkgZip,
  ANKI_FIELD_SEPARATOR as SEP,
  sourceRefSlug,
  stripAnkiFieldHtml,
} from "./anki";

/** A minimal Basic + Cloze `col.models` map (string-keyed, as Anki stores it). */
const MODELS = {
  "1": {
    id: 1,
    name: "Basic",
    type: 0,
    flds: [
      { name: "Front", ord: 0 },
      { name: "Back", ord: 1 },
    ],
  },
  "2": {
    id: 2,
    name: "Cloze",
    type: 1,
    flds: [
      { name: "Text", ord: 0 },
      { name: "Back Extra", ord: 1 },
    ],
  },
};

describe("ankiRowsToNotes (T070)", () => {
  it("splits fields, classifies qa/cloze, derives prompt/answer + cloze, strips HTML", () => {
    const rows: AnkiCollectionRows = {
      models: MODELS,
      notes: [
        {
          id: 100,
          guid: "g-basic",
          mid: 1,
          tags: " geography capitals ",
          flds: `What is the capital of <b>France</b>?${SEP}Paris`,
        },
        {
          id: 200,
          guid: "g-cloze",
          mid: 2,
          tags: "",
          flds: `The capital of France is {{c1::Paris}}.${SEP}`,
        },
      ],
      cards: [{ id: 100, nid: 100, due: 5, ivl: 12, factor: 2500, reps: 7, lapses: 1 }],
      revlog: [
        { id: 1700000000000, cid: 100, ease: 3, ivl: 12 },
        { id: 1700000086400, cid: 100, ease: 2, ivl: 8 },
      ],
    };

    const notes = ankiRowsToNotes(rows);
    expect(notes).toHaveLength(2);

    const basic = notes.find((n) => n.guid === "g-basic");
    expect(basic?.kind).toBe("qa");
    // HTML stripped to plain text.
    expect(basic?.prompt).toBe("What is the capital of France?");
    expect(basic?.answer).toBe("Paris");
    expect(basic?.cloze).toBeNull();
    expect(basic?.tags).toEqual(["geography", "capitals"]);
    // Scheduling + revlog attached.
    expect(basic?.scheduling?.reps).toBe(7);
    expect(basic?.scheduling?.lapses).toBe(1);
    expect(basic?.scheduling?.interval).toBe(12);
    expect(basic?.scheduling?.reviews).toHaveLength(2);
    // Reviews sorted chronologically.
    expect(basic?.scheduling?.reviews[0]?.reviewedAt).toBeLessThan(
      basic?.scheduling?.reviews[1]?.reviewedAt ?? 0,
    );

    const cloze = notes.find((n) => n.guid === "g-cloze");
    expect(cloze?.kind).toBe("cloze");
    expect(cloze?.cloze).toBe("The capital of France is {{c1::Paris}}.");
    expect(cloze?.prompt).toBeNull();
    // No `cards` row ⇒ no scheduling.
    expect(cloze?.scheduling).toBeNull();
  });

  it("skips a note whose model is missing (defensive)", () => {
    const rows: AnkiCollectionRows = {
      models: MODELS,
      notes: [{ id: 1, guid: "g", mid: 999, tags: "", flds: `a${SEP}b` }],
      cards: [],
      revlog: [],
    };
    expect(ankiRowsToNotes(rows)).toHaveLength(0);
  });

  it("collects media filenames referenced by a field", () => {
    const rows: AnkiCollectionRows = {
      models: MODELS,
      notes: [
        {
          id: 1,
          guid: "g",
          mid: 1,
          tags: "",
          flds: `Listen [sound:audio.mp3]${SEP}<img src="diagram.png">`,
        },
      ],
      cards: [],
      revlog: [],
    };
    const notes = ankiRowsToNotes(rows);
    expect(notes[0]?.media).toEqual(["audio.mp3", "diagram.png"]);
  });
});

describe("stripAnkiFieldHtml (T070)", () => {
  it("turns <br>/<div> breaks into spaces + drops residual tags + unescapes entities", () => {
    expect(stripAnkiFieldHtml("line one<br>line two")).toBe("line one line two");
    expect(stripAnkiFieldHtml("<div>A</div><div>B</div>")).toBe("A B");
    expect(stripAnkiFieldHtml("Tom &amp; Jerry")).toBe("Tom & Jerry");
    // A <script> is dropped entirely (security boundary reuse).
    expect(stripAnkiFieldHtml("safe<script>evil()</script>")).toBe("safe");
  });
});

describe("notesToAnkiRows (T070)", () => {
  it("round-trips an ExportNote to rows whose fields/tags carry the source ref", () => {
    const notes: ExportNote[] = [
      {
        id: "card-1",
        kind: "qa",
        prompt: "Capital of France?",
        answer: "Paris",
        tags: ["geo"],
        sourceRef: "Atlas of the World — https://example.com/atlas",
      },
      {
        id: "card-2",
        kind: "cloze",
        cloze: "The capital is {{c1::Paris}}.",
        tags: [],
        sourceRef: null,
      },
    ];
    const firstFieldSha1 = new Map([
      ["card-1", "abcd1234ef567890"],
      ["card-2", "00ff00ff00ff00ff"],
    ]);
    const { notes: rows, cards } = notesToAnkiRows(notes, {
      baseId: 1700000000000,
      firstFieldSha1,
    });

    expect(rows).toHaveLength(2);
    expect(cards).toHaveLength(2);

    const qa = rows[0];
    const fields = (qa?.flds ?? "").split(SEP);
    // Basic: Front, Back, Source.
    expect(fields[0]).toBe("Capital of France?");
    expect(fields[1]).toBe("Paris");
    expect(fields[2]).toBe("Atlas of the World — https://example.com/atlas");
    // The source ref also becomes a provenance tag.
    expect(qa?.tags).toContain("interleave::source::");
    expect(qa?.tags).toContain("geo");
    // csum derived from the supplied sha1.
    expect(qa?.csum).toBe(0xabcd1234);

    const clz = rows[1];
    const clzFields = (clz?.flds ?? "").split(SEP);
    expect(clzFields[0]).toBe("The capital is {{c1::Paris}}.");
    // No source ref ⇒ no interleave provenance tag (just the empty padding).
    expect(clz?.tags).not.toContain("interleave::source::");
  });
});

describe("sourceRefSlug (T070)", () => {
  it("slugifies a source ref deterministically", () => {
    expect(sourceRefSlug("Atlas of the World — https://example.com")).toBe(
      "atlas-of-the-world-https-example-com",
    );
    expect(sourceRefSlug("")).toBe("unknown");
  });
});

describe("parseApkgZip / buildApkgZip (T070)", () => {
  it("is identity on the media map + collection bytes (zip round-trip)", () => {
    const collectionBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const media = { "0": "audio.mp3", "1": "diagram.png" };
    const mediaFiles = {
      "0": new Uint8Array([10, 20, 30]),
      "1": new Uint8Array([40, 50, 60]),
    };
    const apkg = buildApkgZip({ collectionBytes, media, mediaFiles });
    const parsed = parseApkgZip(apkg);

    expect(parsed.collectionVariant).toBe("anki2");
    expect(Array.from(parsed.collectionBytes)).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.media).toEqual(media);
    expect(Array.from(parsed.mediaFiles["0"] ?? [])).toEqual([10, 20, 30]);
    expect(Array.from(parsed.mediaFiles["1"] ?? [])).toEqual([40, 50, 60]);
  });

  it("accepts a legacy collection.anki2 and a newer collection.anki21", () => {
    const a2 = zipSync({
      "collection.anki2": new Uint8Array([7]),
      media: strToU8("{}"),
    });
    expect(parseApkgZip(a2).collectionVariant).toBe("anki2");

    const a21 = zipSync({
      "collection.anki21": new Uint8Array([8]),
      media: strToU8("{}"),
    });
    expect(parseApkgZip(a21).collectionVariant).toBe("anki21");
  });

  it("reports the documented unsupported error for a .anki21b (zstd) archive", () => {
    const a21b = zipSync({
      "collection.anki21b": new Uint8Array([9]),
      media: strToU8("{}"),
    });
    expect(() => parseApkgZip(a21b)).toThrow(AnkiParseError);
    try {
      parseApkgZip(a21b);
    } catch (err) {
      expect((err as AnkiParseError).code).toBe("unsupported_compression");
    }
  });

  it("throws no_collection when no collection entry is present", () => {
    const noCol = zipSync({ media: strToU8("{}") });
    try {
      parseApkgZip(noCol);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AnkiParseError).code).toBe("no_collection");
    }
  });

  it("throws not_a_zip on garbage bytes", () => {
    try {
      parseApkgZip(new Uint8Array([0, 1, 2, 3]));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AnkiParseError).code).toBe("not_a_zip");
    }
  });
});
