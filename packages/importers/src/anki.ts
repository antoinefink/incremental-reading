/**
 * Anki `.apkg` import/export transforms (T070) — PURE, framework-agnostic.
 *
 * Owns the PURE half of Anki interop: the zip wrap/unwrap of the `.apkg` container
 * and the row⇄note mapping over the EMBEDDED Anki collection's `notes`/`cards`/
 * `revlog`/`col` ROW shapes. It does NO I/O and — critically — does NOT open the
 * embedded `collection.anki2` SQLite database: that read/write needs
 * `better-sqlite3`, a native module, which would poison this package's pure,
 * bundle-into-`main.cjs` property. So the split is deliberate:
 *
 *   - THIS module (pure) owns:
 *       - `parseApkgZip` / `buildApkgZip` — the `.apkg` ZIP ↔ {collection bytes,
 *         media map, media files} wrap/unwrap via `fflate` (the zip dep T067 added);
 *       - `ankiRowsToNotes` — already-read Anki collection ROWS → normalized
 *         `AnkiNoteRecord[]` (split `flds` by the model's field list, classify
 *         Basic vs Cloze, derive prompt/answer or cloze, attach scheduling/revlog,
 *         strip field HTML via `sanitizeArticleHtml`);
 *       - `notesToAnkiRows` — Interleave `ExportNote[]` → the Anki `notes`/`cards`
 *         (+ optional `revlog`) ROWS for the minimal Basic/Cloze note types, with
 *         the SOURCE REFERENCE carried into a dedicated `Source` field + a tag;
 *       - `buildAnkiModels` / `buildAnkiDeck` / the field-separator + checksum
 *         helpers Anki's importer needs.
 *   - The MAIN-side `AnkiImportService`/`AnkiExportService` own the
 *     `better-sqlite3` open/read/write of `collection.anki2` + the vault + the
 *     repositories.
 *
 * ## We target Anki's IMPORTER, not byte-identical internals
 *
 * A fully Anki-internal-faithful `collection.anki2` (every `col.conf`/`dconf`
 * field, `usn`, sync metadata) is large + brittle. We ship the MINIMAL valid shape
 * Anki's import accepts: a single Basic note type + a single Cloze note type + one
 * deck, with correct `\x1f` field separators + stable GUIDs + the `csum` first-
 * field checksum Anki uses for note dedup. The contract is the ROUND-TRIP (our
 * import of our export); a manual "imports into real Anki" check is documented but
 * not CI-gated.
 *
 * ## `.apkg` format-version support matrix
 *
 *   - `collection.anki2`  (legacy, uncompressed SQLite)        → import + export ✅
 *   - `collection.anki21` (newer schema, uncompressed SQLite)  → import          ✅
 *   - `collection.anki21b`(zstd-compressed)                    → import          ❌
 *       (reported as a typed `unsupported_compression` error — no pure-JS zstd is
 *        bundled; modern Anki can still EXPORT a legacy `.apkg` we accept).
 *
 * We EXPORT the widely-importable uncompressed `collection.anki2` form.
 */

import { strToU8, unzipSync, zipSync } from "fflate";
import { sanitizeArticleHtml } from "./sanitize";

/** The character Anki uses to separate a note's fields inside the `flds` column. */
export const ANKI_FIELD_SEPARATOR = "\x1f";

/** A typed Anki-parse failure carrying a `code` the import service maps to a friendly line. */
export type AnkiParseErrorCode =
  | "not_a_zip"
  | "no_collection"
  | "unsupported_compression"
  | "empty_collection";

export class AnkiParseError extends Error {
  readonly code: AnkiParseErrorCode;
  constructor(code: AnkiParseErrorCode, message: string) {
    super(message);
    this.name = "AnkiParseError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Normalized intermediate (the import shape)
// ---------------------------------------------------------------------------

/** The SM-2-ish scheduling fields lifted from the Anki `cards`/`revlog` rows. */
export interface AnkiScheduling {
  /** Anki's `cards.due` (interpretation varies by `queue`/`type`; carried verbatim). */
  readonly due: number;
  /** Anki's `cards.ivl` — the current interval in days (negative = seconds, pre-graduation). */
  readonly interval: number;
  /** Anki's `cards.factor` — the SM-2 ease factor in permille (2500 = 250%). */
  readonly ease: number;
  /** Anki's `cards.reps` — total reviews. */
  readonly reps: number;
  /** Anki's `cards.lapses` — total lapses (failed reviews). */
  readonly lapses: number;
  /** The card's revlog entries (chronological), if any were carried. */
  readonly reviews: readonly AnkiReviewLogEntry[];
}

/** One Anki `revlog` entry (an individual past review). */
export interface AnkiReviewLogEntry {
  /** Epoch-ms timestamp of the review (Anki stores `id` as epoch-ms). */
  readonly reviewedAt: number;
  /** Anki ease/button pressed: 1=again, 2=hard, 3=good, 4=easy. */
  readonly rating: number;
  /** The scheduled interval AFTER this review (days; Anki `revlog.ivl`). */
  readonly interval: number;
}

/**
 * The normalized intermediate the main-side import service authors as a `card`
 * element. Every Anki note converges on this shape so the service has ONE
 * card-authoring path regardless of the source note type.
 */
export interface AnkiNoteRecord {
  /** Anki's stable per-note GUID (for dedup / re-import). */
  readonly guid: string;
  /** The note type's name ("Basic", "Cloze", or a custom model name). */
  readonly noteTypeName: string;
  /** The note's raw fields, split by the model's field list (HTML-stripped). */
  readonly fields: readonly string[];
  /** The note's tags (Anki space-separated `tags` column, trimmed + split). */
  readonly tags: readonly string[];
  /** `qa` (Basic) or `cloze` — classified from the model. */
  readonly kind: "qa" | "cloze";
  /** Q&A prompt (Basic front), else null. */
  readonly prompt: string | null;
  /** Q&A answer (Basic back), else null. */
  readonly answer: string | null;
  /** Canonical `{{c1::…}}` cloze text (Cloze text field), else null. */
  readonly cloze: string | null;
  /** The card's scheduling + revlog, when the note had a `cards` row; else null. */
  readonly scheduling: AnkiScheduling | null;
  /** Media filenames referenced by the note's fields (`[sound:…]` / `<img src=…>`). */
  readonly media: readonly string[];
}

// ---------------------------------------------------------------------------
// Raw Anki collection row shapes (what the main-side service reads + hands in)
// ---------------------------------------------------------------------------

/** A raw Anki `notes` row (the columns we read). */
export interface AnkiNotesRow {
  readonly id: number;
  readonly guid: string;
  /** The note type id (`mid` → `col.models[mid]`). */
  readonly mid: number;
  /** Space-separated tags (leading/trailing spaces are Anki's padding). */
  readonly tags: string;
  /** `\x1f`-separated fields. */
  readonly flds: string;
}

/** A raw Anki `cards` row (the scheduling columns we read). */
export interface AnkiCardsRow {
  readonly id: number;
  /** The owning note id (`notes.id`). */
  readonly nid: number;
  readonly due: number;
  readonly ivl: number;
  readonly factor: number;
  readonly reps: number;
  readonly lapses: number;
}

/** A raw Anki `revlog` row (an individual review). */
export interface AnkiRevlogRow {
  /** Epoch-ms timestamp (also the row id). */
  readonly id: number;
  /** The reviewed card id (`cards.id`). */
  readonly cid: number;
  /** Button pressed (1..4). */
  readonly ease: number;
  /** Interval after this review (days, or negative seconds pre-graduation). */
  readonly ivl: number;
}

/** The `col` row's parsed `models` JSON (id → model). */
export interface AnkiModel {
  readonly id: number | string;
  readonly name: string;
  /** The ordered field list — `flds[i].name`. */
  readonly flds: readonly { readonly name: string; readonly ord?: number }[];
  /** Anki sets `type: 1` for cloze note types, `0` for standard. */
  readonly type?: number;
}

/** The already-read Anki collection rows handed to {@link ankiRowsToNotes}. */
export interface AnkiCollectionRows {
  readonly notes: readonly AnkiNotesRow[];
  readonly cards: readonly AnkiCardsRow[];
  readonly revlog: readonly AnkiRevlogRow[];
  /** The parsed `col.models` map (model id as a STRING key, as Anki stores it). */
  readonly models: Readonly<Record<string, AnkiModel>>;
}

// ---------------------------------------------------------------------------
// Import: rows → normalized notes
// ---------------------------------------------------------------------------

/** True when an Anki model is a cloze note type. */
function isClozeModel(model: AnkiModel): boolean {
  if (model.type === 1) return true;
  // Fall back to the name (custom cloze models commonly include "cloze").
  return /cloze/i.test(model.name);
}

/**
 * Strip Anki field HTML to plain text (Anki fields are HTML fragments). Reuses the
 * constrained `sanitizeArticleHtml` allowlist (drops scripts/styles/media tags),
 * then unescapes entities + collapses the remaining whitespace so a Basic
 * front/back becomes a clean single-line prompt/answer. Cloze `{{c1::…}}` markers
 * survive because they are plain text, not HTML.
 */
export function stripAnkiFieldHtml(field: string): string {
  // Anki separates HTML lines with `<br>` / `<div>`; turn block breaks into spaces
  // BEFORE sanitize collapses them away, so "a<br>b" → "a b" not "ab".
  const withBreaks = field
    .replace(/<\s*br\s*\/?\s*>/gi, " ")
    .replace(/<\/\s*(div|p|li|h[1-6])\s*>/gi, " ");
  const sanitized = sanitizeArticleHtml(withBreaks);
  // sanitizeArticleHtml keeps allowlisted inline tags (strong/em/a) as markup; for
  // a card field we want plain text, so drop ALL remaining tags + unescape.
  const noTags = sanitized.replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(noTags).replace(/\s+/g, " ").trim();
}

/** Decode the handful of HTML entities sanitize may leave in field text. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Find the media filenames a field references (`[sound:x.mp3]`, `<img src="y.png">`). */
function mediaInField(field: string): string[] {
  const found: string[] = [];
  for (const m of field.matchAll(/\[sound:([^\]]+)\]/g)) {
    if (m[1]) found.push(m[1]);
  }
  for (const m of field.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
    if (m[1]) found.push(m[1]);
  }
  return found;
}

/** Parse Anki's space-separated, space-padded `tags` column into a clean list. */
export function parseAnkiTags(tags: string): string[] {
  return tags
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Map already-read Anki collection rows to normalized {@link AnkiNoteRecord}[]. PURE.
 *
 * For each note: resolve its model (`mid`), split `flds` by `\x1f`, classify Basic
 * vs Cloze (by the model `type`/name), derive prompt/answer (Basic: field 0/1) or
 * cloze (Cloze: the first non-empty field, already `{{c1::…}}` text), strip field
 * HTML, collect referenced media, and attach the scheduling + revlog from its
 * (first) `cards` row. A note whose model is missing is SKIPPED (defensive).
 */
export function ankiRowsToNotes(rows: AnkiCollectionRows): AnkiNoteRecord[] {
  // Index cards by note id (a note may have >1 card — e.g. multi-cloze; we carry
  // the first card's scheduling + the union of all its cards' revlog).
  const cardsByNote = new Map<number, AnkiCardsRow[]>();
  for (const card of rows.cards) {
    const list = cardsByNote.get(card.nid);
    if (list) list.push(card);
    else cardsByNote.set(card.nid, [card]);
  }
  const revlogByCard = new Map<number, AnkiRevlogRow[]>();
  for (const rl of rows.revlog) {
    const list = revlogByCard.get(rl.cid);
    if (list) list.push(rl);
    else revlogByCard.set(rl.cid, [rl]);
  }

  const out: AnkiNoteRecord[] = [];
  for (const note of rows.notes) {
    const model = rows.models[String(note.mid)];
    if (!model) continue; // unknown note type — cannot split fields reliably.

    const rawFields = note.flds.split(ANKI_FIELD_SEPARATOR);
    const fields = rawFields.map(stripAnkiFieldHtml);
    const media = rawFields.flatMap(mediaInField);
    const tags = parseAnkiTags(note.tags);
    const cloze = isClozeModel(model);

    let prompt: string | null = null;
    let answer: string | null = null;
    let clozeText: string | null = null;
    if (cloze) {
      // Cloze: the text field is the first non-empty field with a `{{cN::…}}` marker,
      // else the first non-empty field.
      clozeText =
        fields.find((f) => /\{\{c\d+::/.test(f)) ?? fields.find((f) => f.length > 0) ?? null;
    } else {
      prompt = fields[0] ?? null;
      answer = fields[1] ?? null;
    }

    const noteCards = cardsByNote.get(note.id) ?? [];
    const scheduling = noteCards.length > 0 ? schedulingFromCards(noteCards, revlogByCard) : null;

    out.push({
      guid: note.guid,
      noteTypeName: model.name,
      fields,
      tags,
      kind: cloze ? "cloze" : "qa",
      prompt,
      answer,
      cloze: clozeText,
      scheduling,
      media,
    });
  }
  return out;
}

/** Build an {@link AnkiScheduling} from a note's card row(s) + their revlog. */
function schedulingFromCards(
  noteCards: readonly AnkiCardsRow[],
  revlogByCard: ReadonlyMap<number, AnkiRevlogRow[]>,
): AnkiScheduling {
  // Use the most-reviewed card as the representative for the note's scheduling.
  const primary = [...noteCards].sort((a, b) => b.reps - a.reps)[0] as AnkiCardsRow;
  const reviews: AnkiReviewLogEntry[] = [];
  for (const card of noteCards) {
    for (const rl of revlogByCard.get(card.id) ?? []) {
      reviews.push({ reviewedAt: rl.id, rating: rl.ease, interval: rl.ivl });
    }
  }
  reviews.sort((a, b) => a.reviewedAt - b.reviewedAt);
  return {
    due: primary.due,
    interval: primary.ivl,
    ease: primary.factor,
    reps: primary.reps,
    lapses: primary.lapses,
    reviews,
  };
}

// ---------------------------------------------------------------------------
// Export: Interleave cards → Anki rows
// ---------------------------------------------------------------------------

/** The minimal Interleave card shape the exporter turns into an Anki note. */
export interface ExportNote {
  readonly kind: "qa" | "cloze";
  readonly prompt?: string | null;
  readonly answer?: string | null;
  readonly cloze?: string | null;
  readonly tags: readonly string[];
  /**
   * A human-readable source reference (title + URL/location) — carried OUT into a
   * dedicated `Source` Anki field AND an `interleave::source::<slug>` tag so the
   * lineage is not lost on the way to Anki. `null` when the card has no source ref.
   */
  readonly sourceRef: string | null;
  /** A stable id used to derive the Anki note GUID (the card element id). */
  readonly id: string;
}

/** Built Anki note + card rows (no revlog — we do not export historical reviews). */
export interface AnkiExportRows {
  readonly notes: readonly BuiltAnkiNote[];
  readonly cards: readonly BuiltAnkiCard[];
}

/** A note row ready to INSERT into the export `collection.anki2`. */
export interface BuiltAnkiNote {
  readonly id: number;
  readonly guid: string;
  readonly mid: number;
  readonly mod: number;
  readonly tags: string;
  readonly flds: string;
  /** The first-field text (Anki computes `sfld` for sort + `csum` for dedup). */
  readonly sfld: string;
  readonly csum: number;
}

/** A card row ready to INSERT into the export `collection.anki2`. */
export interface BuiltAnkiCard {
  readonly id: number;
  readonly nid: number;
  readonly did: number;
  /** Template ordinal (0 for Basic / each cloze index for Cloze). */
  readonly ord: number;
  readonly mod: number;
}

/** The fixed model ids the exporter mints (stable so re-export is deterministic). */
export const EXPORT_BASIC_MODEL_ID = 1700000000001;
export const EXPORT_CLOZE_MODEL_ID = 1700000000002;
/** The single deck id the exporter writes all cards into. */
export const EXPORT_DECK_ID = 1700000000003;

/** The Basic note type's field list — Front, Back, plus our `Source` field. */
export const EXPORT_BASIC_FIELDS = ["Front", "Back", "Source"] as const;
/** The Cloze note type's field list — Text, Back Extra, plus our `Source` field. */
export const EXPORT_CLOZE_FIELDS = ["Text", "Back Extra", "Source"] as const;

/** Slugify a source ref into the `interleave::source::<slug>` tag's slug. */
export function sourceRefSlug(ref: string): string {
  return (
    ref
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "unknown"
  );
}

/**
 * The Anki note-dedup checksum: the first 8 hex digits of SHA-1 of the first
 * field's stripped text, as an integer. Anki uses this in the `notes.csum` column.
 * We compute it from a SHA-1 hex string the caller provides (the main-side service
 * has crypto; this pure module takes the digest so it stays dependency-free).
 */
export function ankiChecksumFromSha1Hex(sha1Hex: string): number {
  return Number.parseInt(sha1Hex.slice(0, 8), 16);
}

/**
 * Build the Anki note + card ROWS for export. PURE. Given Interleave `ExportNote[]`,
 * produce the rows for the minimal Basic/Cloze note types, putting the SOURCE
 * REFERENCE into the dedicated `Source` field AND adding an
 * `interleave::source::<slug>` tag. The caller (main-side service) supplies a
 * per-note SHA-1 hex of the first field (for `csum`) and the base timestamp, since
 * hashing/clock are not pure.
 */
export function notesToAnkiRows(
  notes: readonly ExportNote[],
  options: {
    /** Epoch-ms base; row ids are `baseId + index` so they are unique + stable-ish. */
    readonly baseId: number;
    /** SHA-1 hex of each note's first field, keyed by the note's `id`. */
    readonly firstFieldSha1: ReadonlyMap<string, string>;
  },
): AnkiExportRows {
  const builtNotes: BuiltAnkiNote[] = [];
  const builtCards: BuiltAnkiCard[] = [];
  const mod = Math.floor(options.baseId / 1000);

  notes.forEach((note, i) => {
    const id = options.baseId + i;
    const isCloze = note.kind === "cloze";
    const mid = isCloze ? EXPORT_CLOZE_MODEL_ID : EXPORT_BASIC_MODEL_ID;
    const sourceField = note.sourceRef ?? "";

    const fieldValues = isCloze
      ? [note.cloze ?? "", "", sourceField]
      : [note.prompt ?? "", note.answer ?? "", sourceField];
    const flds = fieldValues.join(ANKI_FIELD_SEPARATOR);
    const sfld = fieldValues[0] ?? "";

    // Tags: the card's tags + an interleave source provenance tag (if a ref exists).
    const tagList = [...note.tags];
    if (note.sourceRef) tagList.push(`interleave::source::${sourceRefSlug(note.sourceRef)}`);
    // Anki stores tags space-separated with a leading + trailing space.
    const tags = tagList.length > 0 ? ` ${tagList.join(" ")} ` : "";

    const sha1 = options.firstFieldSha1.get(note.id);
    const csum = sha1 ? ankiChecksumFromSha1Hex(sha1) : 0;

    builtNotes.push({
      id,
      guid: guidFromId(note.id),
      mid,
      mod,
      tags,
      flds,
      sfld,
      csum,
    });

    // One card per note. For cloze we emit ord 0 (Anki generates the rest on import
    // from the `{{cN}}` markers, but a single card with ord 0 is accepted; multi-
    // cloze fan-out is Anki's job on import).
    builtCards.push({ id, nid: id, did: EXPORT_DECK_ID, ord: 0, mod });
  });

  return { notes: builtNotes, cards: builtCards };
}

/** A stable, Anki-acceptable GUID derived from the Interleave element id. */
export function guidFromId(id: string): string {
  // Anki GUIDs are short base91-ish strings; a stable base64url slice of the id is
  // accepted (it just needs to be unique per note). Keep it deterministic.
  const b64 = Buffer.from(id, "utf8").toString("base64url");
  return b64.slice(0, 16);
}

/**
 * Build the `col.models` JSON for the minimal Basic + Cloze note types. PURE — the
 * main-side service serializes this into the export `collection.anki2`'s `col.models`
 * column. The templates render `{{Front}}`/`{{Back}}` (Basic) and `{{cloze:Text}}`
 * (Cloze); the `Source` field is appended so attribution shows on the card back.
 */
export function buildAnkiModels(mod: number): Record<string, AnkiModel & Record<string, unknown>> {
  const basicTmpl = {
    name: "Card 1",
    ord: 0,
    qfmt: "{{Front}}",
    afmt: "{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}<br><br><small>{{Source}}</small>",
    bqfmt: "",
    bafmt: "",
    did: null,
    bfont: "",
    bsize: 0,
  };
  const clozeTmpl = {
    name: "Cloze",
    ord: 0,
    qfmt: "{{cloze:Text}}",
    afmt: "{{cloze:Text}}<br>\n{{Back Extra}}<br><br><small>{{Source}}</small>",
    bqfmt: "",
    bafmt: "",
    did: null,
    bfont: "",
    bsize: 0,
  };
  const mkFields = (names: readonly string[]) =>
    names.map((name, ord) => ({
      name,
      ord,
      sticky: false,
      rtl: false,
      font: "Arial",
      size: 20,
      media: [],
    }));
  return {
    [String(EXPORT_BASIC_MODEL_ID)]: {
      id: EXPORT_BASIC_MODEL_ID,
      name: "Interleave Basic",
      type: 0,
      mod,
      usn: -1,
      sortf: 0,
      did: EXPORT_DECK_ID,
      tmpls: [basicTmpl],
      flds: mkFields(EXPORT_BASIC_FIELDS),
      css: ".card{font-family:Arial;font-size:20px;text-align:center;color:black;background:white;}",
      latexPre: "",
      latexPost: "",
      latexsvg: false,
      req: [[0, "any", [0]]],
      vers: [],
      tags: [],
    },
    [String(EXPORT_CLOZE_MODEL_ID)]: {
      id: EXPORT_CLOZE_MODEL_ID,
      name: "Interleave Cloze",
      type: 1,
      mod,
      usn: -1,
      sortf: 0,
      did: EXPORT_DECK_ID,
      tmpls: [clozeTmpl],
      flds: mkFields(EXPORT_CLOZE_FIELDS),
      css: ".card{font-family:Arial;font-size:20px;text-align:center;color:black;background:white;}.cloze{font-weight:bold;color:blue;}",
      latexPre: "",
      latexPost: "",
      latexsvg: false,
      req: [[0, "any", [0]]],
      vers: [],
      tags: [],
    },
  };
}

/** Build the `col.decks` JSON for the single export deck. PURE. */
export function buildAnkiDecks(deckName: string, mod: number): Record<string, unknown> {
  return {
    "1": {
      id: 1,
      name: "Default",
      mod,
      usn: -1,
      collapsed: false,
      desc: "",
      dyn: 0,
      conf: 1,
      extendNew: 0,
      extendRev: 0,
      newToday: [0, 0],
      revToday: [0, 0],
      lrnToday: [0, 0],
      timeToday: [0, 0],
    },
    [String(EXPORT_DECK_ID)]: {
      id: EXPORT_DECK_ID,
      name: deckName,
      mod,
      usn: -1,
      collapsed: false,
      desc: "Exported from Interleave",
      dyn: 0,
      conf: 1,
      extendNew: 0,
      extendRev: 0,
      newToday: [0, 0],
      revToday: [0, 0],
      lrnToday: [0, 0],
      timeToday: [0, 0],
    },
  };
}

/** Build the minimal `col.dconf` JSON (deck options) Anki's importer expects. PURE. */
export function buildAnkiDconf(mod: number): Record<string, unknown> {
  return {
    "1": {
      id: 1,
      name: "Default",
      mod,
      usn: -1,
      maxTaken: 60,
      autoplay: true,
      timer: 0,
      replayq: true,
      new: {
        delays: [1, 10],
        ints: [1, 4, 0],
        initialFactor: 2500,
        order: 1,
        perDay: 20,
        bury: false,
      },
      rev: { perDay: 200, ease4: 1.3, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2 },
      lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
      dyn: false,
    },
  };
}

// ---------------------------------------------------------------------------
// `.apkg` zip wrap / unwrap (fflate)
// ---------------------------------------------------------------------------

/** The parsed `.apkg` archive — the collection bytes + the media map + the media files. */
export interface ParsedApkg {
  /** The raw `collection.anki2`/`.anki21` SQLite bytes (the main service opens these). */
  readonly collectionBytes: Uint8Array;
  /** Which collection variant was found ("anki2" or "anki21"). */
  readonly collectionVariant: "anki2" | "anki21";
  /** The `media` JSON map: index string → original filename. */
  readonly media: Record<string, string>;
  /** The media file bytes, keyed by their NUMBERED archive name (e.g. "0", "1"). */
  readonly mediaFiles: Record<string, Uint8Array>;
}

/**
 * Unwrap an `.apkg` (a ZIP) into its collection bytes + media. PURE. Detects the
 * collection variant, REJECTS the zstd-compressed `collection.anki21b` with a typed
 * `unsupported_compression` error (no pure-JS zstd bundled), and throws `not_a_zip`
 * / `no_collection` on a malformed archive.
 */
export function parseApkgZip(bytes: Uint8Array): ParsedApkg {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new AnkiParseError("not_a_zip", "That file is not a valid Anki package (.apkg).");
  }

  // The zstd-compressed modern collection — we cannot read it without a zstd dep.
  if (entries["collection.anki21b"]) {
    throw new AnkiParseError(
      "unsupported_compression",
      "That .apkg uses Anki's newer compressed format (.anki21b), which isn't supported. In Anki, export with “Support older Anki versions” enabled.",
    );
  }

  let collectionBytes: Uint8Array | undefined;
  let collectionVariant: "anki2" | "anki21" = "anki2";
  // Prefer the legacy `.anki2` (broadest support); accept `.anki21`.
  if (entries["collection.anki2"]) {
    collectionBytes = entries["collection.anki2"];
    collectionVariant = "anki2";
  } else if (entries["collection.anki21"]) {
    collectionBytes = entries["collection.anki21"];
    collectionVariant = "anki21";
  }
  if (!collectionBytes) {
    throw new AnkiParseError("no_collection", "That .apkg has no Anki collection inside it.");
  }

  // The `media` JSON map (index → original filename). Absent ⇒ no media.
  let media: Record<string, string> = {};
  const mediaEntry = entries.media;
  if (mediaEntry) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(mediaEntry));
      if (parsed && typeof parsed === "object") media = parsed as Record<string, string>;
    } catch {
      media = {};
    }
  }

  // The numbered media files (every entry that is not the collection / media map).
  const mediaFiles: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    if (
      name === "collection.anki2" ||
      name === "collection.anki21" ||
      name === "collection.anki21b" ||
      name === "media"
    ) {
      continue;
    }
    mediaFiles[name] = content;
  }

  return { collectionBytes, collectionVariant, media, mediaFiles };
}

/**
 * Wrap collection bytes + media into an `.apkg` ZIP. PURE. We always write the
 * legacy `collection.anki2` entry (maximally importable) + the `media` JSON map +
 * the numbered media files. The result imports into Anki and round-trips through
 * {@link parseApkgZip}.
 */
export function buildApkgZip(input: {
  readonly collectionBytes: Uint8Array;
  readonly media: Record<string, string>;
  readonly mediaFiles: Record<string, Uint8Array>;
}): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "collection.anki2": input.collectionBytes,
    media: strToU8(JSON.stringify(input.media)),
  };
  for (const [name, content] of Object.entries(input.mediaFiles)) {
    entries[name] = content;
  }
  return zipSync(entries);
}
