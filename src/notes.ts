import { rowOf, rowsOf, s, type SqlPort, type Statement } from "./db";

export type CountRow = { n: number };
export type IdRow = { id: number };

export interface NoteInput {
  text: string;
  tags: string;
}

type StoredTagsRow = { tags: string };
type NoteHitRow = { id: number; storedAt: string; text: string; tags: string };
type NoteBodyRow = { id: number; text: string };
export type NoteExportRow = {
  id: number;
  text: string;
  tags: string;
  storedAt: string;
  dkey: string | null;
};

const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u2000-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const TAG_GAP = /[\s,]+/;
const MAX_MISS_EDITS = 2;
export function flat(text: string): string {
  return text.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

export function wordList(raw: string | undefined): string[] {
  return [...new Set(flat(raw ?? "").toLowerCase().split(TAG_GAP).filter(Boolean))].sort();
}

const renderTags = (stored: string) => wordList(stored).map((tag) => `#${tag}`).join(" ");

const ftsWord = (word: string) => {
  const phrase = `"${word.replaceAll('"', '""')}"`;
  return `(${phrase}* OR ${phrase})`;
};

export function toFtsQuery(raw: string): string {
  const words = flat(raw)
    .split(" ")
    .filter(Boolean)
    .map(ftsWord);
  if (words.length === 0) return '""';
  return words.join(" OR ");
}

function boundedEdits(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const replaced = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const value = Math.min(replaced, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1);
      current.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  const edits = previous[b.length] ?? limit + 1;
  return edits > limit ? limit + 1 : edits;
}

function nearestMiss(wanted: string, stored: string[]): string | undefined {
  const ranked = stored
    .filter((candidate) => candidate !== wanted)
    .map((candidate) => ({ candidate, edits: boundedEdits(wanted, candidate, MAX_MISS_EDITS) }))
    .filter((miss) => miss.edits <= MAX_MISS_EDITS)
    .sort((left, right) => left.edits - right.edits || left.candidate.localeCompare(right.candidate));
  return ranked[0]?.candidate;
}

export function nearMisses(stored: string[], wanted: string[]): string[] {
  if (wanted.length === 0) return [];
  return wanted.map((tag) => nearestMiss(tag, stored)).filter((miss): miss is string => miss !== undefined);
}

export const noMatchLine = (query: string) =>
  `nothing stored matching "${flat(query).slice(0, 120)}" — the brain holds nothing on this and another query will not find it, so ask the owner or say you do not know`;

const noteLine = (row: NoteHitRow) => {
  const tags = renderTags(row.tags);
  const head = `#${row.id} · stored ${row.storedAt.slice(0, 10)}`;
  return tags ? `${head} · ${row.text} ${tags}` : `${head} · ${row.text}`;
};

const requireNoteCap = (text: string, maxNote: number) => {
  if (text.length === 0) throw new Error("empty text stores nothing");
  if (text.length > maxNote) {
    throw new Error(
      `a note is at most ${maxNote} characters and that is ${text.length}: make it ${text.length - maxNote} shorter, or split it into two notes`,
    );
  }
};

const TAG_SCAN = "SELECT DISTINCT tags FROM notes";
const FIND_BY_DKEY = "SELECT id FROM notes WHERE dkey = ?";
const FIND_NOTE = "SELECT id, text FROM notes WHERE id = ?";
const FIND_NOTE_ID = "SELECT id FROM notes WHERE id = ?";
const ALL_NOTES = "SELECT id, text, tags, at AS storedAt, dkey AS dkey FROM notes ORDER BY rowid";
const DELETE_NOTE_WITH_FRAGMENT = "DELETE FROM notes WHERE id = ? AND instr(text, ?) > 0";
const UPDATE_NOTE_WITH_FRAGMENT =
  `UPDATE notes SET text = ?, at = ?, dkey = ?
    WHERE id = ? AND instr(text, ?) > 0`;
const INSERT_NOTE =
  `INSERT INTO notes (text, tags, at, dkey) VALUES (?, ?, ?, ?)
    ON CONFLICT (dkey) DO NOTHING`;

export function createNoteStore(port: SqlPort, maxNote: number) {
  const flatTags = (rows: StoredTagsRow[]) =>
    [...new Set(rows.flatMap((row) => wordList(row.tags)))];

  async function recall(query: string, limit: number): Promise<string[]> {
    const outcomes = await port.run([
      s(
        `SELECT notes.id AS id, notes.at AS storedAt,
          notes.text AS text, notes.tags AS tags
          FROM notes_ft JOIN notes ON notes.rowid = notes_ft.rowid
          WHERE notes_ft MATCH ?
          ORDER BY bm25(notes_ft, 1.0, 5.0) LIMIT ?`,
        toFtsQuery(query),
        limit,
      ),
    ]);
    return rowsOf<NoteHitRow>(outcomes, 0).map(noteLine);
  }

  async function remember(items: NoteInput[]): Promise<string> {
    const notes = items.map((item) => {
      const text = flat(item.text);
      requireNoteCap(text, maxNote);
      return { text, tags: wordList(item.tags) };
    });
    const writes = await Promise.all(
      notes.map(async (note) => ({
        ...note,
        key: await port.digest([note.text, note.tags.join(" ")]),
      })),
    );
    const at = new Date().toISOString();

    const statements: Statement[] = writes.flatMap((note) => [
      s(TAG_SCAN),
      s(FIND_BY_DKEY, note.key),
      s(INSERT_NOTE, note.text, note.tags.join(" "), at, note.key),
      s(FIND_BY_DKEY, note.key),
    ]);
    const outcomes = await port.run(statements);

    const lines: string[] = [];
    for (const [index, note] of writes.entries()) {
      const at4 = index * 4;
      const held = rowOf<IdRow>(outcomes, at4 + 1);
      if (held) {
        lines.push(`stored #${held.id} (again, same call)`);
        continue;
      }
      const echo = nearMisses(flatTags(rowsOf<StoredTagsRow>(outcomes, at4)), note.tags).map(
        (tag) => `existing tag: "${tag}"`,
      );
      const id = rowOf<IdRow>(outcomes, at4 + 3)?.id ?? 0;
      if (id === 0) throw new Error("the note did not store; nothing was written");
      lines.push([`stored #${id}`, ...echo].join(" · "));
    }
    return lines.join("\n");
  }

  async function patch(noteId: number, confirm: string, raw: string): Promise<string> {
    const text = flat(raw);
    requireNoteCap(text, maxNote);
    const wanted = flat(confirm);
    const key = await port.digest([String(noteId), wanted, text]);

    const found = rowOf<NoteBodyRow>(await port.run([s(FIND_NOTE, noteId)]), 0);
    if (!found) {
      throw new Error(`nothing stored as #${noteId}; run brain_recall and use an id it prints`);
    }
    if (found.text === text) return `patched #${noteId}`;
    if (wanted.length === 0 || !found.text.includes(wanted)) {
      throw new Error(
        `#${noteId} does not contain "${wanted}"; it reads "${found.text}". Nothing changed — brain_patch needs a fragment of that note's own text`,
      );
    }

    const outcomes = await port.run([
      s(UPDATE_NOTE_WITH_FRAGMENT, text, new Date().toISOString(), key, noteId, wanted),
      s(FIND_NOTE, noteId),
    ]);
    const now = rowOf<NoteBodyRow>(outcomes, 1);
    if (!now || now.text !== text) {
      throw new Error(
        `#${noteId} does not contain "${wanted}"; it reads "${now?.text ?? found.text}". Nothing changed — brain_patch needs a fragment of that note's own text`,
      );
    }
    return `patched #${noteId}`;
  }

  async function forget(noteId: number, confirm: string): Promise<string> {
    const wanted = flat(confirm);
    const found = rowOf<NoteBodyRow>(await port.run([s(FIND_NOTE, noteId)]), 0);
    if (!found) throw new Error(`nothing stored as #${noteId}; it may already be gone`);
    if (wanted.length === 0 || !found.text.includes(wanted)) {
      throw new Error(
        `#${noteId} does not contain "${wanted}"; it reads "${found.text}". Nothing deleted — brain_forget needs a fragment of that note's own text`,
      );
    }
    const outcomes = await port.run([
      s(DELETE_NOTE_WITH_FRAGMENT, noteId, wanted),
      s(FIND_NOTE_ID, noteId),
    ]);
    if (rowOf<IdRow>(outcomes, 1)) {
      throw new Error(
        `#${noteId} does not contain "${wanted}"; it reads "${found.text}". Nothing deleted — brain_forget needs a fragment of that note's own text`,
      );
    }
    return `forgot #${noteId}`;
  }

  async function allNotes(): Promise<NoteExportRow[]> {
    const outcomes = await port.run([
      s(ALL_NOTES),
    ]);
    return rowsOf<NoteExportRow>(outcomes, 0);
  }

  return { recall, remember, patch, forget, allNotes };
}
