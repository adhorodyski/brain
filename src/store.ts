export const MAX_NOTE = 300;

export const WHEN_HELP = `Give "at" as an ISO 8601 datetime with its offset (e.g. 2026-03-04T09:00:00+01:00), or "every" as a 5-field cron expression (e.g. "0 8 * * 1-5").`;

export type Note = { noteId: number; text: string; tags: string; storedAt: string };

export type MemoryHost = {
  sql: (statement: string, values?: unknown[]) => Record<string, unknown>[];
  // The Agent scheduler reads these two shapes differently: a string parses as cron, a Date fires once.
  arm: (when: string | Date, payload: { message: string }) => Promise<{ id: string }>;
  disarm: (scheduleId: string) => Promise<boolean>;
};

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plans (key TEXT PRIMARY KEY, message TEXT NOT NULL, at TEXT, every TEXT, schedule_id TEXT, created_at TEXT NOT NULL)`,
];

export function createMemory(host: MemoryHost) {
  const changes = () => Number(host.sql("SELECT changes() AS n")[0]?.n ?? 0);

  const note = (key: string, text: string, tags = ""): number => {
    host.sql("INSERT OR IGNORE INTO notes (key, text, tags, at) VALUES (?, ?, ?, ?)", [
      key,
      text.slice(0, MAX_NOTE),
      tags,
      new Date().toISOString(),
    ]);
    return changes();
  };

  const rememberBatch = (items: { text: string; tags?: string }[], batch: string): string => {
    let stored = 0;
    for (const [index, item] of items.entries()) {
      const body = item.text.trim();
      if (body) stored += note(`${batch}:${index}`, body, item.tags ?? "");
    }
    return stored === 0 ? "Nothing new stored." : `Remembered ${stored} note(s).`;
  };

  return {
    rememberBatch,

    search(query: string, limit = 8): { lines: string[]; total: number } {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      if (words.length === 0) return { lines: [], total: 0 };
      const rows = host.sql(
        `SELECT rowid AS noteId, text, tags, at AS storedAt FROM notes WHERE ${words.map(() => "lower(text) LIKE ?").join(" AND ")} ORDER BY at DESC LIMIT ?`,
        [...words.map((word) => `%${word}%`), Math.min(limit, 30)],
      ) as unknown as Note[];

      return {
        total: rows.length,
        lines: rows.map((row) => `#${row.noteId} ${row.text}${row.tags ? ` [${row.tags}]` : ""} (${row.storedAt.slice(0, 10)})`),
      };
    },

    forget(noteId: number, confirm: string): string {
      const wanted = confirm.trim().toLowerCase();
      if (!wanted) return "Name a few words of the note to confirm it — nothing was removed.";

      const [row] = host.sql("SELECT rowid AS noteId, text FROM notes WHERE rowid = ?", [
        noteId,
      ]) as unknown as Pick<Note, "noteId" | "text">[];
      if (!row) return `There is no note #${noteId}, so nothing was removed. Run recall for fresh numbers.`;

      if (!row.text.toLowerCase().includes(wanted)) {
        return `Note #${noteId} is "${row.text}" — that is not the note you named, so nothing was removed.`;
      }

      host.sql("DELETE FROM notes WHERE rowid = ?", [row.noteId]);
      return `Forgot #${row.noteId}: "${row.text}"`;
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
      const rows = host.sql("SELECT key, schedule_id FROM plans WHERE key LIKE ?", [`%${id}`]);
      if (rows.length === 0) return `There is no schedule ${id}.`;
      for (const row of rows) {
        if (row.schedule_id) await host.disarm(String(row.schedule_id));
        host.sql("DELETE FROM plans WHERE key = ?", [String(row.key)]);
      }
      return `Cancelled ${id}.`;
    },
  };
}

export type Memory = ReturnType<typeof createMemory>;

function brief(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
