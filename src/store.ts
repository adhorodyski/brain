import { MAX_NOTE, WHEN_HELP, defang, MAX_PAGE } from "./tools";

export type Note = { text: string; tags: string; at: string };

/** The slice of the Agent the store needs, so this file holds no harness knowledge. */
export type MemoryHost = {
  sql: (statement: string, values?: unknown[]) => Record<string, unknown>[];
  /** Arm a brain callback: `when` is a cron string or an ISO datetime. */
  arm: (when: string, payload: { message: string }) => Promise<{ id: string }>;
  disarm: (scheduleId: string) => Promise<boolean>;
};

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plans (key TEXT PRIMARY KEY, message TEXT NOT NULL, at TEXT, every TEXT, schedule_id TEXT, created_at TEXT NOT NULL)`,
];

/**
 * Notes and plans, in the brain's own SQLite. Module-scope on purpose: the terminal door and the
 * brain read one table, so a `recall` over MCP is a read and not an agent turn.
 */
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
    note,
    rememberBatch,

    search(query: string, limit = 8): { lines: string[]; total: number } {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
      if (words.length === 0) return { lines: [], total: 0 };
      const rows = host.sql(
        `SELECT text, tags, at FROM notes WHERE ${words.map(() => "lower(text) LIKE ?").join(" AND ")} ORDER BY at DESC LIMIT ?`,
        [...words.map((word) => `%${word}%`), Math.min(limit, 30)],
      ) as unknown as Note[];

      return {
        total: rows.length,
        lines: rows.map((row) => `• ${row.text}${row.tags ? ` [${row.tags}]` : ""} (${row.at.slice(0, 10)})`),
      };
    },

    count(): number {
      return Number(host.sql("SELECT count(*) AS n FROM notes")[0]?.n ?? 0);
    },

    async add(input: { id: string; message: string; at?: string; every?: string }): Promise<string> {
      host.sql("INSERT OR IGNORE INTO plans (key, message, at, every, created_at) VALUES (?, ?, ?, ?, ?)", [
        input.id,
        input.message,
        input.at ?? null,
        input.every ?? null,
        new Date().toISOString(),
      ]);
      if (changes() === 0) return "Already scheduled earlier — left as it was.";

      const when = input.every ?? input.at;
      if (!when) throw new Error(WHEN_HELP);

      const armed = await host.arm(when, { message: input.message });
      host.sql("UPDATE plans SET schedule_id = ? WHERE key = ?", [armed.id, input.id]);

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

    /** Output is fenced and truncated: a page must not become a confident voice inside a durable transcript. */
    async fetchPage(url: string): Promise<string> {
      const target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("http(s) only.");
      const response = await fetch(url, { headers: { "user-agent": "brain/0.1" } });
      const prose = (await response.text())
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_PAGE);
      return `<fetched url="${target.hostname}">\n${defang(prose)}\n</fetched>`;
    },

    forget() {
      host.sql("DELETE FROM notes");
      host.sql("DELETE FROM plans");
      return "Forgot everything.";
    },
  };
}

export type Memory = ReturnType<typeof createMemory>;

function brief(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
