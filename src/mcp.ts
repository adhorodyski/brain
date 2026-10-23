import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ExportReply, Reply } from "./brain";
import type { NoteInput, Principal } from "./store";

const INSTRUCTIONS = `The owner's memory and preferences. Consult it before answering anything about them, and store anything durable before you answer.

Two tables, and the difference is the test: a sentence that can be FALSE is a fact, so store it with
brain_remember; a sentence that can only be OBEYED is an instruction, so store it with brain_learn. If
removing it would change how the next answer is worded, it is an instruction. If removing it would change
which facts the answer cites, it is a note.

brain_recall answers every question about the owner, and every response ends with the owner's standing
instructions. Read them and follow them; they outrank your defaults.`;

const FILL = "Every response ends with the owner's standing instructions; follow them over your own defaults.";

const noteItem = z.object({
  text: z.string().describe("One self-contained fact, at most 300 characters, flattened to a single line"),
  tags: z
    .string()
    .optional()
    .describe("Topic words only, space or comma separated. No dates and no names of people."),
  tier: z
    .union([z.literal("note"), z.literal("core")])
    .optional()
    .describe(
      "core is a small budgeted set that costs tokens on every future request; note is uncapped and reachable only by searching. Default note.",
    ),
});

const exportShape = z.object({
  owner: z.string(),
  notes: z.array(
    z.object({
      id: z.number(),
      text: z.string(),
      tier: z.string().optional(),
      tags: z.string().optional(),
      storedAt: z.string(),
      source: z.string(),
      owner: z.string(),
    }),
  ),
  instructions: z.array(
    z.object({
      id: z.number(),
      text: z.string(),
      scope: z.string().optional(),
      priority: z.number().optional(),
      storedAt: z.string(),
      source: z.string(),
      owner: z.string(),
      active: z.boolean().optional(),
      supersededKey: z.string().nullable().optional(),
    }),
  ),
  counts: z.object({
    notes: z.number(),
    core: z.number(),
    activeInstructions: z.number(),
    allInstructions: z.number(),
  }),
});

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const spoken = (reply: Reply) => ({
  ...text(`${reply.text}\n\n${reply.standing}`),
  ...(reply.failed ? { isError: true } : {}),
});

export function brainServer(brain: BrainHandle, principal: Principal) {
  const server = new McpServer(
    { name: "brain", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  const call = <T>(work: () => Promise<T>, say: (value: T) => { content: { type: "text"; text: string }[]; isError?: boolean }) =>
    work().then(say);

  server.registerTool(
    "brain_recall",
    {
      title: "Recall",
      description: `Search the owner's notes and get back the matching lines, plus related rows that share their tags. Call it before answering anything about the owner, their plans, people, places, or codes. Reads nothing and writes nothing. ${FILL}`,
      inputSchema: z.object({
        query: z.string().describe("Words or a whole question; every word is OR-ed, tags included"),
        limit: z.number().int().min(1).max(30).optional().describe("Maximum rows, default 8"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query, limit }) =>
      call(
        () => brain.recall(query, limit ?? 8, principal),
        spoken,
      ),
  );

  server.registerTool(
    "brain_remember",
    {
      title: "Remember",
      description: `Store facts: anything that could be true or false, such as codes, addresses, decisions, dates, and who people are. One fact per item, self-contained enough to read in a year. Use brain_learn instead for a rule about how to behave. A repeated write with identical text lands once. ${FILL}`,
      inputSchema: z.object({ items: z.array(noteItem).min(1).max(20) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ items }) =>
      call(
        () => brain.remember(items, principal),
        spoken,
      ),
  );

  server.registerTool(
    "brain_patch",
    {
      title: "Patch a note",
      description: `Rewrite one stored note in place. Takes the #number brain_recall printed and confirm, a fragment taken verbatim from that note's own text; the two must agree or nothing changes. Prefer this over brain_forget plus brain_remember when a fact changed. ${FILL}`,
      inputSchema: z.object({
        id: z.number().int().min(1).describe("The note number from a recall line"),
        confirm: z.string().describe("Words copied from that note's current text"),
        text: z.string().describe("The whole new note, at most 300 characters"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id, confirm, text: body }) =>
      call(
        () => brain.patch(id, confirm, body, principal),
        spoken,
      ),
  );

  server.registerTool(
    "brain_forget",
    {
      title: "Forget a note",
      description: `Delete one stored note permanently. Takes the note number and confirm, a fragment of that note's own text; the two must agree or nothing is deleted. Ask the owner first. ${FILL}`,
      inputSchema: z.object({
        id: z.number().int().min(1).describe("The note number from a recall line"),
        confirm: z.string().describe("Words copied from that note's text"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, confirm }) =>
      call(
        () => brain.forget(id, confirm, principal),
        spoken,
      ),
  );

  server.registerTool(
    "brain_learn",
    {
      title: "Learn an instruction",
      description: `Store a standing instruction: a rule about how answers should be given or behaviour changed, reachable through triggers such as next time, not like that, stop doing, always, never, I prefer, don't, should. Call it BEFORE answering, because after answering the shape of the reply is already fixed. One rule per call, at most 200 characters, no links, emails or code. A newer rule on the same topic retires the older one. ${FILL}`,
      inputSchema: z.object({
        text: z.string().describe("The rule, in the owner's own terms, at most 200 characters"),
        scope: z
          .union([
            z.literal("always"),
            z.literal("briefing"),
            z.literal("coding"),
            z.literal("writing"),
          ])
          .optional()
          .describe("When the rule applies; always is the default"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ text: body, scope }) =>
      call(
        () => brain.learn(body, scope ?? "always", principal),
        spoken,
      ),
  );

  server.registerTool(
    "brain_unlearn",
    {
      title: "Retire an instruction",
      description: `Retire one standing instruction. Takes the instruction id from the standing-instruction block or from brain_export, plus confirm, a fragment of that rule's own words; the two must agree or nothing changes. The rule stops shaping replies and stays in the export as history. ${FILL}`,
      inputSchema: z.object({
        id: z.number().int().min(1).describe("The instruction id"),
        confirm: z.string().describe("Words copied from that rule's text"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, confirm }) =>
      call(
        () => brain.unlearn(id, confirm, principal),
        spoken,
      ),
  );

  server.registerTool(
    "brain_export",
    {
      title: "Export the brain",
      description: `Every note and every instruction, including retired ones, as JSON, with counts. Use it to back the archive up, to audit what a host wrote, or to find an instruction id to retire. ${FILL}`,
      outputSchema: exportShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () =>
      call(
        () => brain.export(principal),
        (reply: ExportReply) => {
          const payload = {
            owner: reply.owner,
            notes: reply.notes,
            instructions: reply.instructions,
            counts: reply.counts,
          };
          return {
            content: [{ type: "text" as const, text: `${JSON.stringify(payload)}\n\n${reply.standing}` }],
            structuredContent: payload,
          };
        },
      ),
  );

  return server;
}

export interface BrainHandle {
  recall(query: string, limit: number, principal: Principal): Promise<Reply>;
  remember(items: NoteInput[], principal: Principal): Promise<Reply>;
  patch(id: number, confirm: string, text: string, principal: Principal): Promise<Reply>;
  forget(id: number, confirm: string, principal: Principal): Promise<Reply>;
  learn(text: string, scope: string, principal: Principal): Promise<Reply>;
  unlearn(id: number, confirm: string, principal: Principal): Promise<Reply>;
  export(principal: Principal): Promise<ExportReply>;
}
