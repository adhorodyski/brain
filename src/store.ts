export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;
export type Sql = (statement: string, values?: readonly SqlValue[]) => Row[];

export interface Host {
  sql: Sql;
  transaction<T>(body: () => T): T;
  digest(parts: readonly string[]): Promise<string>;
}

export interface Limits {
  coreTokens: number;
  maxNote: number;
}

export interface Principal {
  owner: string;
  source: string;
}

export interface NoteInput {
  text: string;
  tags?: string;
  tier?: "note" | "core";
}

const TOKEN_CHARS = 3.5;
export const budgetChars = (tokens: number) => Math.floor(tokens * TOKEN_CHARS);
export const percent = (used: number, limit: number) =>
  limit <= 0 ? 0 : Math.round((used / limit) * 100);

const INVISIBLE =
  /[\u0000-\u001F\u007F-\u009F\u00A0\u2000-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const TAG_GAP = /[\s,]+/;
const TAG_NEAR = 2;
export function flat(text: string): string {
  return text.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

function parseTags(raw: string | undefined): string[] {
  return [...new Set(flat(raw ?? "").toLowerCase().split(TAG_GAP).filter(Boolean))].sort();
}

const renderTags = (stored: string) => parseTags(stored).map((tag) => `#${tag}`).join(" ");

function toFtsQuery(raw: string): string {
  const words = flat(raw)
    .split(" ")
    .filter(Boolean)
    .map((word) => `"${word.replaceAll('"', '""')}"`);
  if (words.length === 0) return '""';
  if (words.length === 1) return `${words[0]}* OR ${words[0]}`;
  return words.join(" OR ");
}

function withinGap(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const value = Math.min(
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        previous[j] + 1,
        current[j - 1] + 1,
      );
      current.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

function nearDuplicateTags(host: Host, tags: string[]): string[] {
  if (tags.length === 0) return [];
  const stored = [
    ...new Set(
      host
        .sql("SELECT DISTINCT tags FROM notes")
        .flatMap((row) => parseTags(String(row.tags ?? ""))),
    ),
  ];
  return tags
    .map((tag) =>
      stored.find(
        (candidate) =>
          candidate !== tag &&
          candidate.length > 2 &&
          candidate.length + tag.length >= 9 &&
          withinGap(tag, candidate, TAG_NEAR),
      ),
    )
    .filter((match): match is string => match !== undefined);
}

const NOTE_SELECT = `SELECT notes.rowid AS id, notes.tier AS tier, notes.at AS storedAt,
  notes.text AS text, notes.tags AS tags
  FROM notes_ft JOIN notes ON notes.rowid = notes_ft.rowid
  WHERE notes_ft MATCH ?`;
const NOTE_RANK = " ORDER BY bm25(notes_ft, 1.0, 5.0) LIMIT ?";

const noteLine = (row: Row) => {
  const tags = renderTags(String(row.tags ?? ""));
  const head = `#${row.id} · [${row.tier}] · stored ${String(row.storedAt).slice(0, 10)}`;
  return tags ? `${head} · ${row.text} ${tags}` : `${head} · ${row.text}`;
};

export const refuseOwner = (
  row: Row,
  principal: Principal,
  prefix: string,
  verb: string,
) => {
  if (String(row.owner) === principal.owner) return;
  throw new Error(
    `${prefix}#${row.id} belongs to ${row.owner || "no owner"}, not ${principal.owner}, so only its owner can ${verb} it`,
  );
};

const fitsNote = (text: string, maxNote: number) => {
  if (text.length === 0) throw new Error("empty text stores nothing");
  if (text.length > maxNote) {
    throw new Error(
      `a note is at most ${maxNote} characters and that is ${text.length}: make it ${text.length - maxNote} shorter, or split it into two notes`,
    );
  }
};

const INSERT_NOTE = `INSERT INTO notes (key, text, tags, tier, at, source, owner, dkey)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export function createNoteStore(host: Host, limits: Limits) {
  const coreChars = () =>
    Number(
      host.sql("SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars FROM notes WHERE tier = 'core'")[0]
        ?.chars ?? 0,
    );
  const coreLimit = () => budgetChars(limits.coreTokens);
  const coreFill = (used: number) =>
    `core ${used}/${coreLimit()} (${percent(used, coreLimit())}%)`;

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

  const insertNote = (note: NoteInput, text: string, key: string, at: string, owner: Principal) => {
    host.sql(INSERT_NOTE, [
      crypto.randomUUID(),
      text,
      parseTags(note.tags).join(" "),
      note.tier ?? "note",
      at,
      owner.source,
      owner.owner,
      key,
    ]);
    return Number(host.sql("SELECT last_insert_rowid() AS id")[0]?.id ?? 0);
  };

  function recall(query: string, limit: number): string {
    const hits = host.sql(`${NOTE_SELECT}${NOTE_RANK}`, [toFtsQuery(query), limit]);
    if (hits.length === 0) return `nothing stored matching "${flat(query).slice(0, 120)}"`;

    const lines = hits.map(noteLine);
    const tags = parseTags(String(hits[0].tags ?? ""));
    if (hits.length > 3 || tags.length === 0) return lines.join("\n");

    const seen = hits.map((row) => Number(row.id));
    const neighbours = host.sql(
      `${NOTE_SELECT} AND notes.rowid NOT IN (${seen.map(() => "?").join(", ")})${NOTE_RANK}`,
      [toFtsQuery(tags.join(" ")), ...seen, 3],
    );
    if (neighbours.length === 0) return lines.join("\n");
    return `${lines.join("\n")}\n## Related\n${neighbours.map(noteLine).join("\n")}`;
  }

  async function remember(items: NoteInput[], principal: Principal): Promise<string> {
    const notes = items.map((item) => {
      const text = flat(item.text);
      fitsNote(text, limits.maxNote);
      return { item, text, tags: parseTags(item.tags), tier: item.tier ?? "note" };
    });
    const keys = await Promise.all(
      notes.map((note) =>
        host.digest([principal.owner, note.tier, note.text, note.tags.join(" ")]),
      ),
    );
    const at = new Date().toISOString();

    return host.transaction(() => {
      const lines: string[] = [];
      for (const [index, note] of notes.entries()) {
        const dupe = host.sql("SELECT rowid AS id FROM notes WHERE dkey = ?", [keys[index]])[0];
        if (dupe) {
          lines.push(`stored #${dupe.id} (again, same call)`);
          continue;
        }
        const echo = nearDuplicateTags(host, note.tags).map((tag) => `existing tag: "${tag}"`);
        const used = note.tier === "core" ? coreRoom(note.text.length, 0) : 0;
        const id = insertNote(note.item, note.text, keys[index], at, principal);
        const tail = [
          note.tier === "core" ? coreFill(used) : note.tier,
          ...echo,
        ].join(" · ");
        lines.push(`stored #${id} · ${tail}`);
      }
      return lines.join("\n");
    });
  }

  async function patch(
    noteId: number,
    confirm: string,
    text: string,
    principal: Principal,
  ): Promise<string> {
    const body = flat(text);
    fitsNote(body, limits.maxNote);
    const wanted = flat(confirm);
    const key = await host.digest([principal.owner, String(noteId), wanted, body]);

    return host.transaction(() => {
      const row = host.sql(
        "SELECT rowid AS id, text AS text, tier AS tier, owner AS owner FROM notes WHERE rowid = ?",
        [noteId],
      )[0];
      if (!row) {
        throw new Error(`nothing stored as #${noteId}; run brain_recall and use a number it prints`);
      }
      refuseOwner(row, principal, "", "change");

      const current = String(row.text);
      if (current === body) return `patched #${noteId}`;
      if (wanted.length === 0 || !current.includes(wanted)) {
        throw new Error(
          `#${noteId} does not contain "${wanted}"; it reads "${current}". Nothing changed — brain_patch needs a fragment of that note's own text`,
        );
      }

      const used = String(row.tier) === "core" ? coreRoom(body.length, current.length) : 0;
      host.sql("UPDATE notes SET text = ?, at = ?, source = ?, dkey = ? WHERE rowid = ?", [
        body,
        new Date().toISOString(),
        principal.source,
        key,
        noteId,
      ]);
      return String(row.tier) === "core"
        ? `patched #${noteId} · ${coreFill(used)}`
        : `patched #${noteId}`;
    });
  }

  function forget(noteId: number, confirm: string, principal: Principal): string {
    const wanted = flat(confirm);
    return host.transaction(() => {
      const row = host.sql(
        "SELECT rowid AS id, text AS text, owner AS owner FROM notes WHERE rowid = ?",
        [noteId],
      )[0];
      if (!row) throw new Error(`nothing stored as #${noteId}; it may already be gone`);
      refuseOwner(row, principal, "", "delete");
      if (wanted.length === 0 || !String(row.text).includes(wanted)) {
        throw new Error(
          `#${noteId} does not contain "${wanted}"; it reads "${row.text}". Nothing deleted — brain_forget needs a fragment of that note's own text`,
        );
      }
      host.sql("DELETE FROM notes WHERE rowid = ?", [noteId]);
      return `forgot #${noteId}`;
    });
  }

  function notes(): Row[] {
    return host.sql(
      `SELECT rowid AS id, text AS text, tags AS tags, tier AS tier, at AS storedAt,
        source AS source, owner AS owner FROM notes ORDER BY rowid`,
    );
  }

  return { recall, remember, patch, forget, notes };
}
