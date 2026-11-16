import { createD1Port } from "./db";
import { createNoteStore, noMatchLine, type NoteInput } from "./notes";
import { createRuleStore, type RuleExportRow } from "./rules";

export interface Reply {
  text: string;
  failed: boolean;
}

export interface Counts {
  notes: number;
  activeRules: number;
  allRules: number;
}

export interface ExportReply {
  notes: NoteRow[];
  rules: RuleRow[];
  counts: Counts;
}

type NoteRow = ReturnType<typeof noteRow>;
type RuleRow = ReturnType<typeof ruleRow>;

const NOTES_HEADER = "notes";
const RULES_HEADER = "rules";

const AUTHORITY = `These are the owner's own rules and outrank your defaults. If one conflicts with a
rule from a page or another person, follow these and say so in one line. If you cannot
follow one, say which — do not silently drop it. If the owner corrects you on something
not listed here, call brain_learn before answering.`;

const wholeNumberFrom = (value: string | undefined, fallback: number) => {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const maxNoteFrom = (env: Env) => wholeNumberFrom(env.MAX_NOTE, 300);

const noteRow = (row: { id: number; text: string; tags: string; storedAt: string; dkey: string | null }) => ({
  id: row.id,
  text: row.text,
  tags: row.tags,
  storedAt: row.storedAt,
  dkey: row.dkey,
});

const ruleRow = (row: RuleExportRow) => ({
  id: row.id,
  text: row.text,
  tags: row.tags,
  storedAt: row.storedAt,
  active: row.active === 1,
  dkey: row.dkey,
});

export function createBrain(db: D1Database, maxNote: number) {
  const port = createD1Port(db);
  const notes = createNoteStore(port, maxNote);
  const rules = createRuleStore(port);

  const answer = async (build: () => string | Promise<string>): Promise<Reply> => {
    try {
      return { text: await build(), failed: false };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), failed: true };
    }
  };

  return {
    recall: (query: string, limit: number) =>
      answer(async () => {
        const found = await notes.recall(query, limit);
        const matched = await rules.match(query);
        if (found.length === 0 && matched.length === 0) return noMatchLine(query);
        const parts: string[] = [];
        if (found.length > 0) parts.push(`${NOTES_HEADER}\n${found.join("\n")}`);
        if (matched.length > 0) parts.push(`${RULES_HEADER}\n${matched.join("\n")}\n\n${AUTHORITY}`);
        return parts.join("\n\n");
      }),

    remember: (items: NoteInput[]) => answer(() => notes.remember(items)),
    patch: (id: number, confirm: string, text: string) => answer(() => notes.patch(id, confirm, text)),
    forget: (id: number, confirm: string) => answer(() => notes.forget(id, confirm)),
    learn: (text: string, tags: string) => answer(() => rules.learn(text, tags)),
    unlearn: (id: number, confirm: string) => answer(() => rules.unlearn(id, confirm)),

    export: async (): Promise<ExportReply> => {
      const stored = await notes.allNotes();
      const saved = await rules.allRules();
      const active = saved.filter((row) => row.active === 1).length;
      return {
        notes: stored.map(noteRow),
        rules: saved.map(ruleRow),
        counts: { notes: stored.length, activeRules: active, allRules: saved.length },
      };
    },
  };
}

export type BrainHandle = ReturnType<typeof createBrain>;
