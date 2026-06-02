/**
 * Anki collection (better-sqlite3) read/write — MAIN-side ONLY (T070).
 *
 * The embedded `collection.anki2` inside an `.apkg` is itself a SQLite database, so
 * reading/writing it needs `better-sqlite3` — a NATIVE module. This module owns that
 * native access and is deliberately kept OUT of the pure `@interleave/importers`
 * package (which must bundle into `main.cjs` without native bindings). The
 * `AnkiImportService`/`AnkiExportService` compose this helper with the pure
 * `@interleave/importers` row⇄note transforms.
 *
 * The Electron main process must open SQLite with the Electron-ABI native binary
 * (the same one the app DB uses); callers pass the resolved `nativeBinding` path so
 * the Anki collection opens against the correct ABI.
 */

import type {
  AnkiCardsRow,
  AnkiCollectionRows,
  AnkiModel,
  AnkiNotesRow,
  AnkiRevlogRow,
} from "@interleave/importers";
import Database from "better-sqlite3";

/** Open a raw better-sqlite3 handle (Electron-ABI binding when provided). */
function openRaw(filePath: string, nativeBinding: string | undefined): Database.Database {
  return nativeBinding ? new Database(filePath, { nativeBinding }) : new Database(filePath);
}

/**
 * Read the `notes`/`cards`/`revlog`/`col` rows from an Anki `collection.anki2` file.
 * Read-only. The `col.models` JSON is parsed into the {@link AnkiModel} map the pure
 * `ankiRowsToNotes` transform consumes. Closes the handle before returning.
 */
export function readAnkiCollection(
  filePath: string,
  nativeBinding: string | undefined,
): AnkiCollectionRows {
  const db = openRaw(filePath, nativeBinding);
  db.pragma("query_only = ON");
  try {
    const notes = db.prepare("SELECT id, guid, mid, tags, flds FROM notes").all() as AnkiNotesRow[];
    const cards = db
      .prepare("SELECT id, nid, due, ivl, factor, reps, lapses FROM cards")
      .all() as AnkiCardsRow[];
    // A fresh/never-studied export may have an empty revlog; tolerate a missing table.
    let revlog: AnkiRevlogRow[] = [];
    try {
      revlog = db.prepare("SELECT id, cid, ease, ivl FROM revlog").all() as AnkiRevlogRow[];
    } catch {
      revlog = [];
    }
    const colRow = db.prepare("SELECT models FROM col LIMIT 1").get() as
      | { models: string }
      | undefined;
    const models = parseModels(colRow?.models);
    return { notes, cards, revlog, models };
  } finally {
    db.close();
  }
}

/** Parse the `col.models` JSON into a string-keyed {@link AnkiModel} map. */
function parseModels(modelsJson: string | undefined): Record<string, AnkiModel> {
  if (!modelsJson) return {};
  try {
    const parsed = JSON.parse(modelsJson) as Record<string, AnkiModel>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The minimal pieces of a `col` row the export writes. */
export interface AnkiColData {
  readonly crt: number;
  readonly mod: number;
  readonly models: string;
  readonly decks: string;
  readonly dconf: string;
  readonly conf: string;
}

/** A built note row to insert (mirrors `@interleave/importers` BuiltAnkiNote). */
export interface InsertNoteRow {
  readonly id: number;
  readonly guid: string;
  readonly mid: number;
  readonly mod: number;
  readonly tags: string;
  readonly flds: string;
  readonly sfld: string;
  readonly csum: number;
}

/** A built card row to insert (mirrors `@interleave/importers` BuiltAnkiCard). */
export interface InsertCardRow {
  readonly id: number;
  readonly nid: number;
  readonly did: number;
  readonly ord: number;
  readonly mod: number;
}

/**
 * Write a MINIMAL but Anki-importable `collection.anki2` at `filePath`: the schema
 * Anki's importer accepts (the `col` row + `notes` + `cards` + an empty `revlog` /
 * `graves`), the single `col` row built from {@link AnkiColData}, and the supplied
 * note/card rows. We target Anki's IMPORTER, not byte-identical internals. Closes
 * the handle before returning.
 */
export function writeAnkiCollection(
  filePath: string,
  col: AnkiColData,
  notes: readonly InsertNoteRow[],
  cards: readonly InsertCardRow[],
  nativeBinding: string | undefined,
): void {
  const db = openRaw(filePath, nativeBinding);
  try {
    db.exec(ANKI_SCHEMA_SQL);
    // The single `col` row (id 1). Anki's importer reads models/decks/dconf/conf.
    db.prepare(
      `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
       VALUES (1, @crt, @mod, @scm, 11, 0, 0, 0, @conf, @models, @decks, @dconf, '{}')`,
    ).run({ ...col, scm: col.mod });

    const insertNote = db.prepare(
      `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
       VALUES (@id, @guid, @mid, @mod, -1, @tags, @flds, @sfld, @csum, 0, '')`,
    );
    const insertCard = db.prepare(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
       VALUES (@id, @nid, @did, @ord, @mod, -1, 0, 0, @id, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
    );
    const tx = db.transaction(() => {
      for (const note of notes) insertNote.run(note);
      for (const card of cards) insertCard.run(card);
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * The minimal Anki collection schema (the subset Anki's importer needs). Mirrors
 * Anki's historical `collection.anki2` DDL — `col`, `notes`, `cards`, `revlog`,
 * `graves` + the indexes Anki creates. Kept verbatim so the file is a valid Anki DB.
 */
const ANKI_SCHEMA_SQL = `
CREATE TABLE col (
  id integer PRIMARY KEY,
  crt integer NOT NULL,
  mod integer NOT NULL,
  scm integer NOT NULL,
  ver integer NOT NULL,
  dty integer NOT NULL,
  usn integer NOT NULL,
  ls integer NOT NULL,
  conf text NOT NULL,
  models text NOT NULL,
  decks text NOT NULL,
  dconf text NOT NULL,
  tags text NOT NULL
);
CREATE TABLE notes (
  id integer PRIMARY KEY,
  guid text NOT NULL,
  mid integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  tags text NOT NULL,
  flds text NOT NULL,
  sfld integer NOT NULL,
  csum integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
);
CREATE TABLE cards (
  id integer PRIMARY KEY,
  nid integer NOT NULL,
  did integer NOT NULL,
  ord integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  type integer NOT NULL,
  queue integer NOT NULL,
  due integer NOT NULL,
  ivl integer NOT NULL,
  factor integer NOT NULL,
  reps integer NOT NULL,
  lapses integer NOT NULL,
  left integer NOT NULL,
  odue integer NOT NULL,
  odid integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
);
CREATE TABLE revlog (
  id integer PRIMARY KEY,
  cid integer NOT NULL,
  usn integer NOT NULL,
  ease integer NOT NULL,
  ivl integer NOT NULL,
  lastIvl integer NOT NULL,
  factor integer NOT NULL,
  time integer NOT NULL,
  type integer NOT NULL
);
CREATE TABLE graves (
  usn integer NOT NULL,
  oid integer NOT NULL,
  type integer NOT NULL
);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`;
