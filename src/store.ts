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

export interface Limits {
  coreTokens: number;
  maxNote: number;
}

export interface NoteInput {
  text: string;
  tags: string;
  tier: "note" | "core";
}

export type CharsRow = { chars: number };
export type CountRow = { n: number };
type StoredTagsRow = { tags: string };
type NoteHitRow = { id: string; tier: string; storedAt: string; text: string; tags: string };
type NoteBodyRow = { id: string; text: string; tier: string };
type NoteTextRow = { id: string; text: string };
export type NoteExportRow = {
  id: string;
  text: string;
  tags: string;
  tier: string;
  storedAt: string;
};

const TOKEN_CHARS = 3.5;
export const budgetChars = (tokens: number) => Math.floor(tokens * TOKEN_CHARS);
export const percent = (used: number, limit: number) =>
  limit <= 0 ? 0 : Math.round((used / limit) * 100);

export function newId(): string {
  const stamp = Date.now().toString(36);
  const noise = crypto.getRandomValues(new Uint8Array(6));
  return `c${stamp}${[...noise].map((b) => b.toString(36).padStart(2, "0")).join("")}`;
}

const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u00A0\u2000-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const TAG_GAP = /[\s,]+/;
const TAG_NEAR = 2;
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

function withinGap(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
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
    if (best > limit) return false;
    previous = current;
  }
  return (previous[b.length] ?? 0) <= limit;
}

export function nearDuplicates(stored: string[], wanted: string[]): string[] {
  if (wanted.length === 0) return [];
  return wanted
    .map((tag) => stored.find((candidate) => candidate !== tag && withinGap(tag, candidate, TAG_NEAR)))
    .filter((match): match is string => match !== undefined);
}

const NOTE_SELECT = `SELECT notes.id AS id, notes.tier AS tier, notes.at AS storedAt,
  notes.text AS text, notes.tags AS tags
  FROM notes_ft JOIN notes ON notes.rowid = notes_ft.rowid
  WHERE notes_ft MATCH ?`;
const NOTE_RANK = " ORDER BY bm25(notes_ft, 1.0, 5.0) LIMIT ?";

export const noMatchLine = (query: string) =>
  `nothing stored matching "${flat(query).slice(0, 120)}" — the archive holds nothing on this and another query will not find it, so ask the owner or say you do not know`;

const noteLine = (row: NoteHitRow) => {
  const tags = renderTags(row.tags);
  const head = `#${row.id} · [${row.tier}] · stored ${row.storedAt.slice(0, 10)}`;
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

const INSERT_NOTE = `INSERT INTO notes (id, text, tags, tier, at, dkey)
  VALUES (?, ?, ?, ?, ?, ?)`;

export function createNoteStore(port: SqlPort, limits: Limits) {
  const coreChars = () =>
    port.sql<CharsRow>("SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars FROM notes WHERE tier = 'core'")[0]
      ?.chars ?? 0;
  const coreLimit = () => budgetChars(limits.coreTokens);
  const coreFill = (used: number) =>
    `core ${used}/${coreLimit()} (${percent(used, coreLimit())}%)`;

  const storedTags = () =>
    [...new Set(port.sql<StoredTagsRow>("SELECT DISTINCT tags FROM notes").flatMap((row) => wordList(row.tags)))];

  const coreRoom = (add: number, replace: number) => {
    const limit = coreLimit();
    const used = coreChars() - replace + add;
    if (used > limit) {
      throw new Error(
        `the core tier holds ${coreChars() - replace} of its ${limit} characters and this note needs ${add}, which is ${used - limit} over. Shorten it, store it as a note, or retire a core note with brain_forget`,
      );
    }
    return used;
  };

  const insertNote = (note: NoteInput, text: string, key: string, at: string) => {
    const insertId = newId();
    port.sql(INSERT_NOTE, [
      insertId,
      text,
      wordList(note.tags).join(" "),
      note.tier,
      at,
      key,
    ]);
    return insertId;
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
      fitsNote(text, limits.maxNote);
      return { item, text, tags: wordList(item.tags), tier: item.tier };
    });
    const writes = await Promise.all(
      notes.map(async (note) => ({
        ...note,
        key: await port.digest([note.tier, note.text, note.tags.join(" ")]),
      })),
    );
    const at = new Date().toISOString();

    return port.transaction(() => {
      const lines: string[] = [];
      for (const note of writes) {
        const dupe = port.sql<{ id: string }>("SELECT id AS id FROM notes WHERE dkey = ?", [note.key])[0];
        if (dupe) {
          lines.push(`stored #${dupe.id} (again, same call)`);
          continue;
        }
        const echo = nearDuplicates(storedTags(), note.tags).map((tag) => `existing tag: "${tag}"`);
        const used = note.tier === "core" ? coreRoom(note.text.length, 0) : 0;
        const id = insertNote(note.item, note.text, note.key, at);
        const tail = [
          note.tier === "core" ? coreFill(used) : note.tier,
          ...echo,
        ].join(" · ");
        lines.push(`stored #${id} · ${tail}`);
      }
      return lines.join("\n");
    });
  }

  async function patch(noteId: string, confirm: string, text: string): Promise<string> {
    const body = flat(text);
    fitsNote(body, limits.maxNote);
    const wanted = flat(confirm);
    const key = await port.digest([noteId, wanted, body]);

    return port.transaction(() => {
      const row = port.sql<NoteBodyRow>(
        "SELECT id AS id, text AS text, tier AS tier FROM notes WHERE id = ?",
        [noteId],
      )[0];
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

      const used = row.tier === "core" ? coreRoom(body.length, current.length) : 0;
      port.sql("UPDATE notes SET text = ?, at = ?, dkey = ? WHERE id = ?", [
        body,
        new Date().toISOString(),
        key,
        noteId,
      ]);
      return row.tier === "core" ? `patched #${noteId} · ${coreFill(used)}` : `patched #${noteId}`;
    });
  }

  function forget(noteId: string, confirm: string): string {
    const wanted = flat(confirm);
    return port.transaction(() => {
      const row = port.sql<NoteTextRow>(
        "SELECT id AS id, text AS text FROM notes WHERE id = ?",
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
      `SELECT id AS id, text AS text, tags AS tags, tier AS tier, at AS storedAt
        FROM notes ORDER BY rowid`,
    );
  }

  return { recall, remember, patch, forget, notes };
}
