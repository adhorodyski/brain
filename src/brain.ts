import { DurableObject } from "cloudflare:workers";
import { createInstructionStore, type RuleExportRow } from "./instruct";
import {
  createNoteStore,
  type Host,
  type NoteExportRow,
  type NoteInput,
  type SqlRow,
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

const numberFrom = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const noteRow = (row: NoteExportRow) => ({
  id: row.id,
  text: row.text,
  tier: row.tier,
  tags: row.tags,
  storedAt: row.storedAt,
});

const ruleRow = (row: RuleExportRow) => ({
  id: row.id,
  text: row.text,
  scope: row.scope,
  priority: row.priority,
  storedAt: row.storedAt,
  active: row.active === 1,
  supersededKey: row.supersededKey,
});

export class Brain extends DurableObject<Env> {
  private notes;
  private instructions;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const host: Host = {
      sql: <T extends SqlRow>(statement: string, values?: readonly SqlValue[]) =>
        [...this.ctx.storage.sql.exec<T>(statement, ...(values ?? []))],
      transaction: (body) => this.ctx.storage.transactionSync(body),
      digest: async (parts) => {
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
        return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      },
    };

    this.notes = createNoteStore(host, {
      coreTokens: numberFrom(env.CORE_TOKENS, 900),
      maxNote: numberFrom(env.MAX_NOTE, 300),
    });
    this.instructions = createInstructionStore(host, {
      instructTokens: numberFrom(env.INSTRUCT_TOKENS, 300),
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
    const core = notes.filter((row) => row.tier === "core").length;
    const active = instructions.filter((row) => row.active === 1).length;
    return {
      standing: this.instructions.block(this.env.TIMEZONE ?? "UTC"),
      notes: notes.map(noteRow),
      instructions: instructions.map(ruleRow),
      counts: { notes: notes.length, core, activeInstructions: active, allInstructions: instructions.length },
    };
  }
}
