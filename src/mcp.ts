import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ExportReply, Reply } from "./brain";
import { MAX_RULE } from "./rules";
import type { NoteInput } from "./notes";

const HANDSHAKE = `Call brain_recall before coding, testing, investigating, writing prose, drafting a pull request, or answering anything about the owner: it returns the owner's notes and the rules they set for that task.

Two tables, and the difference is the test: a sentence that can be FALSE is a note, so store it with
brain_remember; a sentence that can only be OBEYED is a rule, so store it with brain_learn. If
removing it would change how the next answer is worded, it is a rule. If removing it would change
which notes the answer cites, it is a note.

brain_recall answers a question with both kinds, and its rules section outranks your defaults. Rules
are found by relevance to the query and nothing else: nothing is injected at session start, so a Brain you
do not consult is a Brain that stays silent. Store a correction with brain_learn as soon as you get one.`;

const noteItem = (maxNote: number) =>
  z.object({
    text: z
      .string()
      .describe(`One self-contained note, at most ${maxNote} characters, flattened to a single line`),
    tags: z
      .string()
      .optional()
      .describe("Tag words only, space or comma separated. No dates and no names of people."),
  });

const exportShape = z.object({
  notes: z.array(
    z.object({
      id: z.number(),
      text: z.string(),
      tags: z.string(),
      storedAt: z.string(),
    }),
  ),
  rules: z.array(
    z.object({
      id: z.number(),
      text: z.string(),
      tags: z.string(),
      storedAt: z.string(),
      active: z.boolean(),
    }),
  ),
  counts: z.object({
    notes: z.number(),
    activeRules: z.number(),
    allRules: z.number(),
  }),
});

const textResult = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const spoken = (reply: Reply): CallToolResult => ({
  ...textResult(reply.text),
  ...(reply.failed ? { isError: true } : {}),
});

export function brainServer(brain: BrainHandle, maxNote: number) {
  const server = new McpServer(
    { name: "brain", version: "0.1.0" },
    { instructions: HANDSHAKE },
  );

  server.registerTool(
    "brain_recall",
    {
      title: "Recall",
      description: `Recall from the brain and get back the matching notes and the matching rules. Call it before coding, testing, investigating, writing prose, or drafting a pull request, and before answering anything about the owner, their plans, people, places, or codes. Put the task in the query, not just a name: "write tests for the parser" finds the testing rules, "parser" may not. Reads nothing and writes nothing. An empty result is final: another query will not find it, so ask the owner.`,
      inputSchema: z.object({
        query: z.string().describe("Words or a whole question; every word is OR-ed, note tags and rule tags included"),
        limit: z.number().int().min(1).max(30).optional().describe("Maximum notes, default 8; rules are capped at 3"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query, limit }) => brain.recall(query, limit ?? 8).then(spoken),
  );

  server.registerTool(
    "brain_remember",
    {
      title: "Remember",
      description: `Store notes: anything that could be true or false, such as codes, addresses, decisions, dates, and who people are. One note per item, self-contained enough to read in a year. Use brain_learn instead for a rule about how to behave. A repeated write with identical text lands once.`,
      inputSchema: z.object({ items: z.array(noteItem(maxNote)).min(1).max(20) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ items }) =>
      brain
        .remember(items.map((item) => ({ text: item.text, tags: item.tags ?? "" })))
        .then(spoken),
  );

  server.registerTool(
    "brain_patch",
    {
      title: "Patch a note",
      description: `Rewrite one stored note in place. Takes the #id brain_recall printed and confirm, a fragment of that note's own text; the two must agree or nothing changes. Prefer this over brain_forget plus brain_remember when a note changed.`,
      inputSchema: z.object({
        id: z.number().int().min(1).describe("The note id from a recall line"),
        confirm: z.string().describe("Words copied from that note's text"),
        text: z.string().describe(`The whole new note, at most ${maxNote} characters`),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id, confirm, text }) => brain.patch(id, confirm, text).then(spoken),
  );

  server.registerTool(
    "brain_forget",
    {
      title: "Forget a note",
      description: `Delete one stored note permanently. Takes the note id and confirm, a fragment of that note's own text; the two must agree or nothing is deleted. Ask the owner first.`,
      inputSchema: z.object({
        id: z.number().int().min(1).describe("The note id from a recall line"),
        confirm: z.string().describe("Words copied from that note's text"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, confirm }) => brain.forget(id, confirm).then(spoken),
  );

  server.registerTool(
    "brain_learn",
    {
      title: "Learn a rule",
      description: `Store a rule for how answers should be given or behaviour changed. Call it AS SOON AS the owner corrects you, before answering, because after answering the shape of the reply is already fixed. One rule per call, at most ${MAX_RULE} characters, no links, emails or code. Give it tags: the words a later search will use to find it, and put those words in the rule too, because a rule tagged writing is missed by "write the release notes". Storing the same rule again with new tags replaces it; a different rule sharing a tag is stored beside it, never silently retired.`,
      inputSchema: z.object({
        text: z.string().describe(`The rule, in the owner's own terms, at most ${MAX_RULE} characters`),
        tags: z
          .string()
          .describe(
            "The words a search will use to find this rule, such as testing, prs, or prose. Tag words only, space or comma separated",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ text, tags }) => brain.learn(text, tags).then(spoken),
  );

  server.registerTool(
    "brain_unlearn",
    {
      title: "Retire a rule",
      description: `Retire one rule. Takes the r#id brain_recall or brain_learn prints beside that rule, plus confirm, a fragment of that rule's own text; the two must agree or nothing changes. The rule stops shaping replies and stays in the export as history.`,
      inputSchema: z.object({
        id: z.number().int().min(1).describe("The rule id, without the r prefix"),
        confirm: z.string().describe("Words copied from that rule's text"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, confirm }) => brain.unlearn(id, confirm).then(spoken),
  );

  server.registerTool(
    "brain_export",
    {
      title: "Export the brain",
      description: `Every note and every rule, including retired ones, as JSON, with counts. For backups and audits. Never after brain_recall finds nothing: another query will not find it either, and this dumps every row into the conversation.`,
      outputSchema: exportShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () =>
      brain.export().then((payload: ExportReply) => ({
        ...textResult(JSON.stringify(payload)),
        structuredContent: payload,
      })),
  );

  return server;
}

export interface BrainHandle {
  recall(query: string, limit: number): Promise<Reply>;
  remember(items: NoteInput[]): Promise<Reply>;
  patch(id: number, confirm: string, text: string): Promise<Reply>;
  forget(id: number, confirm: string): Promise<Reply>;
  learn(text: string, tags: string): Promise<Reply>;
  unlearn(id: number, confirm: string): Promise<Reply>;
  export(): Promise<ExportReply>;
}
