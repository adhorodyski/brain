export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
export type Sql = <T extends SqlRow = SqlRow>(
  statement: string,
  values?: readonly SqlValue[],
) => T[];

export interface SqlPort {
  sql: Sql;
  transaction<T>(body: () => T): T;
  digest(parts: readonly string[]): Promise<string>;
}

export interface NoteInput {
  text: string;
  tags: string;
}

export type CountRow = { n: number };
export type IdRow = { id: number };
type StoredTagsRow = { tags: string };
type NoteHitRow = { id: number; storedAt: string; text: string; tags: string };
type NoteBodyRow = { id: number; text: string };
type NoteTextRow = { id: number; text: string };
export type NoteExportRow = {
  id: number;
  text: string;
  tags: string;
  storedAt: string;
};


const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u00A0\u2000-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const TAG_GAP = /[\s,]+/;
const MAX_TAG_EDITS = 2;
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

function nearestMatch(wanted: string, stored: string[]): string | undefined {
  const ranked = stored
    .filter((candidate) => candidate !== wanted)
    .map((candidate) => ({ candidate, edits: boundedEdits(wanted, candidate, MAX_TAG_EDITS) }))
    .filter((match) => match.edits <= MAX_TAG_EDITS)
    .sort((left, right) => left.edits - right.edits || left.candidate.localeCompare(right.candidate));
  return ranked[0]?.candidate;
}

export function nearDuplicates(stored: string[], wanted: string[]): string[] {
  if (wanted.length === 0) return [];
  return wanted.map((tag) => nearestMatch(tag, stored)).filter((match): match is string => match !== undefined);
}

const NOTE_SELECT = `SELECT notes.id AS id, notes.at AS storedAt,
  notes.text AS text, notes.tags AS tags
  FROM notes_ft JOIN notes ON notes.rowid = notes_ft.rowid
  WHERE notes_ft MATCH ?`;
const NOTE_RANK = " ORDER BY bm25(notes_ft, 1.0, 5.0) LIMIT ?";

export const noMatchLine = (query: string) =>
  `nothing stored matching "${flat(query).slice(0, 120)}" — the archive holds nothing on this and another query will not find it, so ask the owner or say you do not know`;

const noteLine = (row: NoteHitRow) => {
  const tags = renderTags(row.tags);
  const head = `#${row.id} · stored ${row.storedAt.slice(0, 10)}`;
  return tags ? `${head} · ${row.text} ${tags}` : `${head} · ${row.text}`;
};

const fitsNote = (text: string, maxNote: number) => {
  if (text.length === 0) throw new Error("empty text stores nothing");
  if (text.length > maxNote) {
    throw new Error(
      `a note is at most ${maxNote} characters and that is ${text.length}: make it ${text.length - maxNote} shorter, or split it into two notes`,
    );
  }
};

const INSERT_NOTE = `INSERT INTO notes (text, tags, at, dkey)
  VALUES (?, ?, ?, ?)`;

export function createNoteStore(port: SqlPort, maxNote: number) {
  const storedTags = () =>
    [...new Set(port.sql<StoredTagsRow>("SELECT DISTINCT tags FROM notes").flatMap((row) => wordList(row.tags)))];

  const insertNote = (note: NoteInput, text: string, key: string, at: string) => {
    port.sql(INSERT_NOTE, [text, wordList(note.tags).join(" "), at, key]);
    return port.sql<IdRow>("SELECT last_insert_rowid() AS id")[0]?.id ?? 0;
  };

  function recall(query: string, limit: number): string[] {
    const hits = port.sql<NoteHitRow>(`${NOTE_SELECT}${NOTE_RANK}`, [toFtsQuery(query), limit]);
    const [lead] = hits;
    if (!lead) return [];

    const lines = hits.map(noteLine);
    const tags = wordList(lead.tags);
    if (hits.length > 3 || tags.length === 0) return lines;

    const seen = hits.map((row) => row.id);
    const neighbours = port.sql<NoteHitRow>(
      `${NOTE_SELECT} AND notes.id NOT IN (${seen.map(() => "?").join(", ")})${NOTE_RANK}`,
      [toFtsQuery(tags.join(" ")), ...seen, 3],
    );
    if (neighbours.length === 0) return lines;
    return [...lines, "## Related", ...neighbours.map(noteLine)];
  }

  async function remember(items: NoteInput[]): Promise<string> {
    const notes = items.map((item) => {
      const text = flat(item.text);
      fitsNote(text, maxNote);
      return { item, text, tags: wordList(item.tags) };
    });
    const writes = await Promise.all(
      notes.map(async (note) => ({
        ...note,
        key: await port.digest([note.text, note.tags.join(" ")]),
      })),
    );
    const at = new Date().toISOString();

    return port.transaction(() => {
      const lines: string[] = [];
      for (const note of writes) {
        const dupe = port.sql<IdRow>("SELECT id FROM notes WHERE dkey = ?", [note.key])[0];
        if (dupe) {
          lines.push(`stored #${dupe.id} (again, same call)`);
          continue;
        }
        const echo = nearDuplicates(storedTags(), note.tags).map((tag) => `existing tag: "${tag}"`);
        const id = insertNote(note.item, note.text, note.key, at);
        lines.push([`stored #${id}`, ...echo].join(" · "));
      }
      return lines.join("\n");
    });
  }

  async function patch(noteId: number, confirm: string, text: string): Promise<string> {
    const body = flat(text);
    fitsNote(body, maxNote);
    const wanted = flat(confirm);
    const key = await port.digest([String(noteId), wanted, body]);

    return port.transaction(() => {
      const row = port.sql<NoteBodyRow>("SELECT id, text FROM notes WHERE id = ?", [noteId])[0];
      if (!row) {
        throw new Error(`nothing stored as #${noteId}; run brain_recall and use a number it prints`);
      }

      const current = row.text;
      if (current === body) return `patched #${noteId}`;
      if (wanted.length === 0 || !current.includes(wanted)) {
        throw new Error(
          `#${noteId} does not contain "${wanted}"; it reads "${current}". Nothing changed — brain_patch needs a fragment of that note's own text`,
        );
      }

      port.sql("UPDATE notes SET text = ?, at = ?, dkey = ? WHERE id = ?", [
        body,
        new Date().toISOString(),
        key,
        noteId,
      ]);
      return `patched #${noteId}`;
    });
  }

  function forget(noteId: number, confirm: string): string {
    const wanted = flat(confirm);
    return port.transaction(() => {
      const row = port.sql<NoteTextRow>(
        "SELECT id, text FROM notes WHERE id = ?",
        [noteId],
      )[0];
      if (!row) throw new Error(`nothing stored as #${noteId}; it may already be gone`);
      if (wanted.length === 0 || !row.text.includes(wanted)) {
        throw new Error(
          `#${noteId} does not contain "${wanted}"; it reads "${row.text}". Nothing deleted — brain_forget needs a fragment of that note's own text`,
        );
      }
      port.sql("DELETE FROM notes WHERE id = ?", [noteId]);
      return `forgot #${noteId}`;
    });
  }

  function notes(): NoteExportRow[] {
    return port.sql<NoteExportRow>(
      `SELECT id, text, tags, at AS storedAt
        FROM notes ORDER BY rowid`,
    );
  }

  return { recall, remember, patch, forget, notes };
}
