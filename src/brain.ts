import { DurableObject } from "cloudflare:workers";
import { createInstructionStore } from "./instruct";
import {
  createNoteStore,
  type Host,
  type NoteInput,
  type Row,
  type SqlValue,
} from "./store";

export interface Reply {
  text: string;
  standing: string;
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
  standing: string;
  notes: NoteRow[];
  instructions: RuleRow[];
  counts: Counts;
}

const SCHEMA = [
  `CREATE TABLE notes (
    key    TEXT PRIMARY KEY,
    text   TEXT NOT NULL,
    tags   TEXT NOT NULL DEFAULT '',
    tier   TEXT NOT NULL DEFAULT 'note',
    at     TEXT NOT NULL,
    dkey   TEXT UNIQUE
  )`,
  `CREATE VIRTUAL TABLE notes_ft USING fts5(text, tags, content='notes', content_rowid='rowid')`,
  `CREATE INDEX notes_tier ON notes(tier)`,
  `CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END`,
  `CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_ft(notes_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
    INSERT INTO notes_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END`,
  `CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_ft(notes_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  END`,
  `CREATE TABLE instructions (
    key            TEXT PRIMARY KEY,
    text           TEXT NOT NULL,
    when_scope     TEXT NOT NULL DEFAULT 'always',
    priority       INTEGER NOT NULL DEFAULT 0,
    at             TEXT NOT NULL,
    active         INTEGER NOT NULL DEFAULT 1,
    superseded_key TEXT,
    dkey           TEXT UNIQUE
  )`,
];

const wholeNumberFrom = (value: string | undefined, fallback: number) => {
  const parsed = Math.trunc(Number(value));
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
  scope: String(row.scope),
  priority: Number(row.priority),
  storedAt: String(row.storedAt),
  active: Number(row.active) === 1,
  supersededKey: row.supersededKey === null ? null : String(row.supersededKey),
});

export class Brain extends DurableObject<Env> {
  private notes;
  private instructions;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const host: Host = {
      sql: (statement, values) =>
        [...this.ctx.storage.sql.exec<Record<string, SqlValue>>(statement, ...(values ?? []))],
      transaction: (body) => this.ctx.storage.transactionSync(body),
      digest: async (parts) => {
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
        return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      },
    };

    this.notes = createNoteStore(host, {
      coreTokens: wholeNumberFrom(env.CORE_TOKENS, 900),
      maxNote: wholeNumberFrom(env.MAX_NOTE, 300),
    });
    this.instructions = createInstructionStore(host, {
      instructTokens: wholeNumberFrom(env.INSTRUCT_TOKENS, 300),
    });
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const built = [...this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'notes'")];
    if (built.length > 0) return;
    for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);
  }

  private async answer(build: () => string | Promise<string>): Promise<Reply> {
    const block = () => this.instructions.block(this.env.TIMEZONE ?? "UTC");
    try {
      return { text: await build(), standing: block(), failed: false };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), standing: block(), failed: true };
    }
  }

  async recall(query: string, limit: number): Promise<Reply> {
    return this.answer(() => this.notes.recall(query, limit));
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

  async learn(text: string, scope: string): Promise<Reply> {
    return this.answer(() => this.instructions.learn(text, scope));
  }

  async unlearn(id: number, confirm: string): Promise<Reply> {
    return this.answer(() => this.instructions.unlearn(id, confirm));
  }

  async export(): Promise<ExportReply> {
    const notes = this.notes.notes();
    const instructions = this.instructions.instructions();
    const core = notes.filter((row) => String(row.tier) === "core").length;
    const active = instructions.filter((row) => Number(row.active) === 1).length;
    return {
      standing: this.instructions.block(this.env.TIMEZONE ?? "UTC"),
      notes: notes.map(noteRow),
      instructions: instructions.map(ruleRow),
      counts: { notes: notes.length, core, activeInstructions: active, allInstructions: instructions.length },
    };
  }
}
