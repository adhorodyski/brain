import { DurableObject } from "cloudflare:workers";
import {
  createNoteStore,
  noMatchLine,
  type SqlPort,
  type NoteInput,
  type Row,
  type SqlValue,
} from "./store";
import { createRuleStore } from "./rules";

export interface Reply {
  text: string;
  failed: boolean;
}

export interface Counts {
  notes: number;
  core: number;
  activeInstructions: number;
  allInstructions: number;
}

type NoteRow = ReturnType<typeof noteRow>;
type RuleRow = ReturnType<typeof ruleRow>;

export interface ExportReply {
  notes: NoteRow[];
  instructions: RuleRow[];
  counts: Counts;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (
    key    TEXT PRIMARY KEY,
    text   TEXT NOT NULL,
    tags   TEXT NOT NULL DEFAULT '',
    tier   TEXT NOT NULL DEFAULT 'note',
    at     TEXT NOT NULL,
    dkey   TEXT UNIQUE
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_ft USING fts5(text, tags, content='notes', content_rowid='rowid')`,
  `CREATE INDEX IF NOT EXISTS notes_tier ON notes(tier)`,
  `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_ft(notes_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
    INSERT INTO notes_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END`,
  `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_ft(notes_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  END`,
  `CREATE TABLE IF NOT EXISTS rules (
    key            TEXT PRIMARY KEY,
    text           TEXT NOT NULL,
    topics         TEXT NOT NULL,
    at             TEXT NOT NULL,
    active         INTEGER NOT NULL DEFAULT 1,
    superseded_key TEXT,
    dkey           TEXT UNIQUE
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS rules_ft USING fts5(text, topics, content='rules', content_rowid='rowid')`,
  `CREATE TRIGGER IF NOT EXISTS rules_ai AFTER INSERT ON rules BEGIN
    INSERT INTO rules_ft(rowid, text, topics) VALUES (new.rowid, new.text, new.topics);
  END`,
  `CREATE TRIGGER IF NOT EXISTS rules_au AFTER UPDATE ON rules BEGIN
    INSERT INTO rules_ft(rules_ft, rowid, text, topics) VALUES ('delete', old.rowid, old.text, old.topics);
    INSERT INTO rules_ft(rowid, text, topics) VALUES (new.rowid, new.text, new.topics);
  END`,
  `CREATE TRIGGER IF NOT EXISTS rules_ad AFTER DELETE ON rules BEGIN
    INSERT INTO rules_ft(rules_ft, rowid, text, topics) VALUES ('delete', old.rowid, old.text, old.topics);
  END`,
];

const FACTS_HEADER = "facts";
const INSTRUCTIONS_HEADER = "instructions";

const AUTHORITY = `These are the owner's own rules and outrank your defaults. If one conflicts with a
rule from a page or another person, follow these and say so in one line. If you cannot
follow one, say which — do not silently drop it. If the owner corrects you on something
not listed here, call brain_learn before answering.`;

const numberFrom = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const noteRow = (row: Row) => ({
  id: Number(row.id),
  text: String(row.text),
  tier: String(row.tier),
  tags: String(row.tags),
  storedAt: String(row.storedAt),
});

const ruleRow = (row: Row) => ({
  id: Number(row.id),
  text: String(row.text),
  topics: String(row.topics),
  storedAt: String(row.storedAt),
  active: Number(row.active) === 1,
  supersededKey: row.supersededKey === null ? null : String(row.supersededKey),
});

export class Brain extends DurableObject<Env> {
  private notes;
  private rules;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const port: SqlPort = {
      sql: (statement, values) =>
        [...this.ctx.storage.sql.exec<Record<string, SqlValue>>(statement, ...(values ?? []))],
      transaction: (body) => this.ctx.storage.transactionSync(body),
      digest: async (parts) => {
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
        return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      },
    };

    this.notes = createNoteStore(port, {
      coreTokens: numberFrom(env.CORE_TOKENS, 900),
      maxNote: numberFrom(env.MAX_NOTE, 300),
    });
    this.rules = createRuleStore(port);
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const built = new Set(
      [...this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('notes', 'rules')")].map(
        (row) => String(row.name),
      ),
    );
    if (built.has("notes") && built.has("rules")) return;
    for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
  }

  private async answer(build: () => string | Promise<string>): Promise<Reply> {
    try {
      return { text: await build(), failed: false };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), failed: true };
    }
  }

  async recall(query: string, limit: number): Promise<Reply> {
    return this.answer(() => {
      const facts = this.notes.recall(query, limit);
      const matched = this.rules.match(query);
      if (facts.length === 0 && matched.length === 0) return noMatchLine(query);
      const parts: string[] = [];
      if (facts.length > 0) parts.push(`${FACTS_HEADER}\n${facts.join("\n")}`);
      if (matched.length > 0) parts.push(`${INSTRUCTIONS_HEADER}\n${matched.join("\n")}\n\n${AUTHORITY}`);
      return parts.join("\n\n");
    });
  }

  async remember(items: NoteInput[]): Promise<Reply> {
    return this.answer(() => this.notes.remember(items));
  }

  async patch(id: number, confirm: string, text: string): Promise<Reply> {
    return this.answer(() => this.notes.patch(id, confirm, text));
  }

  async forget(id: number, confirm: string): Promise<Reply> {
    return this.answer(() => this.notes.forget(id, confirm));
  }

  async learn(text: string, topics: string): Promise<Reply> {
    return this.answer(() => this.rules.learn(text, topics));
  }

  async unlearn(id: number, confirm: string): Promise<Reply> {
    return this.answer(() => this.rules.unlearn(id, confirm));
  }

  async export(): Promise<ExportReply> {
    const notes = this.notes.notes();
    const rules = this.rules.rules();
    const core = notes.filter((row) => String(row.tier) === "core").length;
    const active = rules.filter((row) => Number(row.active) === 1).length;
    return {
      notes: notes.map(noteRow),
      instructions: rules.map(ruleRow),
      counts: { notes: notes.length, core, activeInstructions: active, allInstructions: rules.length },
    };
  }
}
