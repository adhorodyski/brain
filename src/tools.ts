import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Memory } from "./store";

export const DEFAULT_BRAIN = "brain";

/** The name the brain calls you, and the Durable Object it lives in. */
export const BRAIN_NAME = (env: { BRAIN_NAME?: string }) => env.BRAIN_NAME ?? DEFAULT_BRAIN;
export const DEFAULT_TIMEZONE = "UTC";
export const MAX_NOTE = 300;

export const WHEN_HELP = `Give "at" as an ISO 8601 datetime with its offset (e.g. 2026-03-04T09:00:00+01:00), or "every" as a 5-field cron expression (e.g. "0 8 * * 1-5").`;

const said = (text: string) => ({ output: [{ type: "text" as const, text }] });

/** The brain's three hands. Each is `replay: "safe"` because each is keyed on the call that made it. */
export function brainExtension(memory: Memory, identity: { who: string; zone: string }) {
  const { who, zone } = identity;

  const remember = defineTool({
    name: "remember",
    description:
      "Store durable notes so they can be recalled months from now. Use for facts, decisions, preferences, codes, commitments. One self-contained fact per item — never chatter about the conversation itself.",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          text: Type.String({ description: `One fact, under ${MAX_NOTE} characters` }),
          tags: Type.Optional(Type.String({ description: "Short comma-separated labels, e.g. health,kids" })),
        }),
        { description: "One or more notes, all stored in this call" },
      ),
    }),
    replay: "safe",
    execute: async ({ items }, api) => said(memory.rememberBatch(items, `${api.taskId}:${api.callId}`)),
  });

  const recall = defineTool({
    name: "recall",
    description:
      "Search stored notes and get the raw matching lines back. The cheapest read of memory — call it before answering anything about the past. It returns text; it does not reason.",
    parameters: Type.Object({
      query: Type.String({ description: "Words that should appear in the note" }),
      limit: Type.Optional(Type.Number({ description: "Max lines. Default 8, max 30" })),
    }),
    replay: "safe",
    execute: async ({ query, limit }) => {
      const found = memory.search(query, limit ?? 8);
      return said(found.total === 0 ? `Nothing stored matching "${query}".` : found.lines.join("\n"));
    },
  });

  const schedule = defineTool({
    name: "schedule",
    description: `Set, list, or cancel things the brain says later, with nothing of mine running. Actions: add (message, plus at or every), list, cancel (id). ${WHEN_HELP}`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("cancel")]),
      message: Type.Optional(Type.String({ description: "add: what to send then, written to stand alone" })),
      at: Type.Optional(Type.String({ description: "add, one-off: ISO 8601 datetime" })),
      every: Type.Optional(Type.String({ description: "add, recurring: 5-field cron" })),
      id: Type.Optional(Type.String({ description: "cancel: an id from list" })),
    }),
    replay: "safe",
    execute: async ({ action, message, at, every, id }, api) => {
      if (action === "list") return said(memory.list());
      if (action === "cancel") {
        if (!id) throw new Error("cancel needs an id from list.");
        return said(await memory.cancel(id));
      }
      if (!message) throw new Error(`add needs a message. ${WHEN_HELP}`);
      return said(await memory.add({ id: `${api.taskId}:${api.callId}`, message, at, every }));
    },
  });


  return defineExtension({
    name: "brain",
    tools: [remember, recall, schedule],
    sections: [
      {
        key: "preamble",
        tag: false,
        render: () =>
          `You are the assistant brain for ${who}: their notes, their memory, their calendar. Answer briefly and concretely. Before answering anything about their past, call recall rather than guessing. Say you do not know when nothing is stored.\nRight now it is ${new Date().toISOString().replace("T", " ").slice(0, 16)} in ${zone}.`,
      },
    ],
  });
}
