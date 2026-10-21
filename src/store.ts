import { MAX_NOTE, WHEN_HELP } from "./tools";

export type Tier = "note" | "core";

export type Note = { noteId: number; text: string; tags: string; tier: Tier; storedAt: string };

export type MemoryHost = {
  sql: (statement: string, values?: unknown[]) => Record<string, unknown>[];
  // The Agent scheduler reads these two shapes differently: a string parses as cron, a Date fires once.
  arm: (when: string | Date, payload: { message: string }) => Promise<{ id: string }>;
  disarm: (scheduleId: string) => Promise<boolean>;
};

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL DEFAULT 'note', at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plans (key TEXT PRIMARY KEY, message TEXT NOT NULL, at TEXT, every TEXT, schedule_id TEXT, created_at TEXT NOT NULL)`,
];

export function migrate(sql: MemoryHost["sql"]): void {
  const columns = sql("SELECT name FROM pragma_table_info('notes')").map((row) => String(row.name));
  if (!columns.includes("tier")) sql("ALTER TABLE notes ADD COLUMN tier TEXT NOT NULL DEFAULT 'note'");
}

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** One line, nothing hidden: whitespace first, so a newline becomes a space before controls go. */
export function flat(text: string): string {
  return text.replace(/\s+/g, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim();
}

const CHARS_PER_TOKEN = 4;
export const TOKENS = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

function accepted(text: string): string {
  const body = flat(text);
  if (!body) throw new Error("Say what to remember.");
  if (body.length > MAX_NOTE) {
    throw new Error(
      `A note is ${MAX_NOTE} characters at most and this is ${body.length}: make it ${String(body.length - MAX_NOTE)} shorter, or split it into separate items.`,
    );
  }
  return body;
}

export function createMemory(host: MemoryHost, coreBudgetTokens: number) {
  const changes = () => Number(host.sql("SELECT changes() AS n")[0]?.n ?? 0);

  const note = (key: string, text: string, tags: string, tier: Tier): number => {
    host.sql("INSERT OR IGNORE INTO notes (key, text, tags, tier, at) VALUES (?, ?, ?, ?, ?)", [
      key,
      text,
      tags,
      tier,
      new Date().toISOString(),
    ]);
    return changes();
  };

  const find = (noteId: number): Stored | undefined =>
    host.sql("SELECT rowid AS noteId, text, tier FROM notes WHERE rowid = ?", [noteId])[0] as
      | Stored
      | undefined;

  const coreUsed = (): number => {
    const rows = host.sql("SELECT text FROM notes WHERE tier = 'core'") as unknown as Pick<Note, "text">[];
    return TOKENS(rows.map((row) => row.text).join("\n"));
  };

  const rememberBatch = (
    items: { text: string; tags?: string; tier?: Tier }[],
    batch: string,
  ): string => {
    const bodies = items.map((item) => ({ text: accepted(item.text), tags: flat(item.tags ?? ""), tier: item.tier ?? ("note" as Tier) }));
    const incoming = bodies.filter((body) => body.tier === "core").reduce((sum, body) => sum + TOKENS(body.text), 0);

    if (incoming > 0) {
      const used = coreUsed();
      if (used + incoming > coreBudgetTokens) {
        throw new Error(
          `core is at ${used}/${coreBudgetTokens} tokens and this adds ${incoming}: revise or forget a core item first, or save these as notes.`,
        );
      }
    }

    let stored = 0;
    for (const [index, body] of bodies.entries()) stored += note(`${batch}:${index}`, body.text, body.tags, body.tier);
    if (stored === 0) return "Nothing new stored.";

    const after = coreUsed();
    const pressure =
      after === 0 || after * 5 < coreBudgetTokens * 4
        ? ""
        : ` core now ${Math.round((after / coreBudgetTokens) * 100)}% (${after}/${coreBudgetTokens} tokens) — revise or forget before adding more.`;
    return `Remembered ${stored} note(s).${pressure}`;
  };

  const coreBlock = (): string => {
    const rows = host.sql("SELECT rowid AS noteId, text, at FROM notes WHERE tier = 'core' ORDER BY at ASC, rowid ASC") as unknown as Note[];
    const used = coreUsed();
    const head = `core [${Math.round((used / coreBudgetTokens) * 100)}% — ${used}/${coreBudgetTokens} tokens]`;
    if (rows.length === 0) return `${head}\nNothing in core yet.`;
    return `${head}\n${rows.map((row) => `- #${row.noteId} ${row.text}`).join("\n")}`;
  };

  return {
    rememberBatch,
    coreBlock,
    coreUsed,

    search(query: string, limit = 8): { lines: string[]; total: number } {
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .map((word) => flat(word))
        .filter(Boolean)
        .slice(0, 8);
      if (words.length === 0) return { lines: [], total: 0 };

      const perWord = words.flatMap((word) => [`%${word}%`, `%${word}%`]);
      const score = words
        .map(() => "(CASE WHEN lower(text) LIKE ? THEN 2 ELSE 0 END + CASE WHEN lower(tags) LIKE ? THEN 1 ELSE 0 END)")
        .join(" + ");
      const match = words.map(() => "(lower(text) LIKE ? OR lower(tags) LIKE ?)").join(" OR ");

      const rows = host.sql(
        `SELECT rowid AS noteId, text, tags, tier, at AS storedAt, ${score} AS hits FROM notes WHERE ${match} ORDER BY hits DESC, at DESC LIMIT ?`,
        [...perWord, ...perWord, Math.min(limit, 30)],
      ) as unknown as (Note & { hits: number })[];

      return {
        total: rows.length,
        lines: rows.map(
          (row) =>
            `#${row.noteId} ${row.text}${row.tags ? ` [${row.tags}]` : ""}${row.tier === "core" ? " (core)" : ""} (${row.storedAt.slice(0, 10)})`,
        ),
      };
    },

    forget(noteId: number, confirm: string): string {
      const wanted = flat(confirm).toLowerCase();
      if (!wanted) return "Name a few words of the note to confirm it — nothing was removed.";

      const row = find(noteId);
      if (!row) return `There is no note #${noteId}, so nothing was removed. Run recall for fresh numbers.`;
      if (!agrees(row, wanted)) return mismatch(noteId, row, "removed");

      host.sql("DELETE FROM notes WHERE rowid = ?", [row.noteId]);
      return `Forgot #${row.noteId}: "${row.text}"`;
    },

    revise(noteId: number, confirm: string, text: string): string {
      const wanted = flat(confirm).toLowerCase();
      if (!wanted) return "Name a few words of the note to confirm it — nothing was changed.";

      const body = accepted(text);
      const row = find(noteId);
      if (!row) return `There is no note #${noteId}, so nothing was changed. Run recall for fresh numbers.`;

      if (!agrees(row, wanted)) {
        // Run again after a restart, this call's own rewrite is what left the confirm words gone.
        if (row.text === body) return `Revised #${row.noteId} already reads "${body}"${row.tier === "core" ? " (core)" : ""}.`;
        return mismatch(noteId, row, "changed");
      }

      if (row.tier === "core") {
        const freed = TOKENS(row.text);
        const after = coreUsed() - freed + TOKENS(body);
        if (after > coreBudgetTokens) {
          throw new Error(
            `core is at ${coreUsed()}/${coreBudgetTokens} tokens and this rewrite lands on ${after}: shorten it, or revise it into a note instead.`,
          );
        }
      }

      host.sql("UPDATE notes SET text = ? WHERE rowid = ?", [body, row.noteId]);
      return `Revised #${row.noteId}: "${row.text}" → "${body}"${row.tier === "core" ? " (core)" : ""}`;
    },

    async add(input: { id: string; message: string; at?: string; every?: string }): Promise<string> {
      const at = input.at === undefined ? undefined : new Date(input.at);
      if (at !== undefined && Number.isNaN(at.getTime())) {
        throw new Error(`"${input.at}" is not a datetime. ${WHEN_HELP}`);
      }
      const when = input.every ?? at;
      if (when === undefined) throw new Error(WHEN_HELP);

      host.sql("INSERT OR IGNORE INTO plans (key, message, at, every, created_at) VALUES (?, ?, ?, ?, ?)", [
        input.id,
        input.message,
        input.at ?? null,
        input.every ?? null,
        new Date().toISOString(),
      ]);
      if (changes() === 0) return "Already scheduled earlier — left as it was.";

      try {
        const armed = await host.arm(when, { message: input.message });
        host.sql("UPDATE plans SET schedule_id = ? WHERE key = ?", [armed.id, input.id]);
      } catch (error) {
        host.sql("DELETE FROM plans WHERE key = ?", [input.id]);
        throw error;
      }

      return input.every
        ? `Scheduled: every ${input.every} — "${brief(input.message)}"`
        : `Scheduled: ${input.at} — "${brief(input.message)}"`;
    },

    list(): string {
      const rows = host.sql("SELECT key, message, at, every FROM plans ORDER BY created_at DESC LIMIT 30");
      if (rows.length === 0) return "Nothing is scheduled.";
      return rows
        .map((row) => `${String(row.key).slice(-6)}: ${row.every ? `every ${row.every}` : row.at} — ${brief(String(row.message))}`)
        .join("\n");
    },

    async cancel(id: string): Promise<string> {
      const wanted = id.trim();
      if (!wanted) return "Name an id from list to cancel — nothing was cancelled.";

      const rows = host.sql("SELECT key, message, schedule_id FROM plans") as unknown as Plan[];
      const matches = rows.filter((row) => row.key.endsWith(wanted));
      if (matches.length === 0) return `There is no schedule ${wanted}, so nothing was cancelled. Run list for fresh ids.`;
      if (matches.length > 1)
        return `${matches.length} schedules end with ${wanted}, so nothing was cancelled. Cancel with a longer id:\n${matches
          .map((row) => `  ${row.key}: "${brief(row.message)}"`)
          .join("\n")}`;

      const [match] = matches;
      if (match.schedule_id) await host.disarm(match.schedule_id);
      host.sql("DELETE FROM plans WHERE key = ?", [match.key]);
      return `Cancelled ${match.key}: "${brief(match.message)}"`;
    },
  };
}

export type Memory = ReturnType<typeof createMemory>;

type Plan = { key: string; message: string; schedule_id: string | null };

type Stored = { noteId: number; text: string; tier: Tier };

/** A confirm matches the note's own text, or the caller reports the mismatch instead of acting. */
function agrees(row: Stored, wanted: string): boolean {
  return row.text.toLowerCase().includes(wanted);
}

function mismatch(noteId: number, row: Stored, outcome: "removed" | "changed"): string {
  return `Note #${noteId} is "${row.text}" — that is not the note you named, so nothing was ${outcome}.`;
}

function brief(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
