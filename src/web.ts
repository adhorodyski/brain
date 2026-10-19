import { webFetchTool } from "agents/webfetch/pi";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { BRAIN_NAME } from "./tools";

type ToolContext = Parameters<ToolRegistration["execute"]>[2];

// Cloudflare's adapter declares this argument `_api` and never reads it, and pi does not re-export the
// chord Context type, so a call from outside a brain turn has to build both shapes by hand.
const NO_TURN_API = {} as ToolExecutionApi;
const NO_TURN_CONTEXT = (budgetMs: number): ToolContext => ({
  abortSignal: AbortSignal.timeout(budgetMs),
  value: () => undefined,
  toString: () => "readPage",
});

function webPolicy(env: Env) {
  return {
    binding: env.AI,
    userAgent: `${BRAIN_NAME(env)} (+https://github.com/adhorodyski/durable-personal-agent)`,
    allowedHosts: hostPatterns(env.WEB_ALLOWED_HOSTS),
    blockedHosts: hostPatterns(env.WEB_BLOCKED_HOSTS),
    maxBytes: 2_000_000,
    maxRedirects: 3,
    pageChars: 12_000,
    timeoutMs: 20_000,
  };
}

export function brainWebTool(env: Env): ToolRegistration {
  return renamesContentToOutput(webFetchTool(webPolicy(env)));
}

export async function readPage(
  env: Env,
  input: { url: string; offset?: number; format?: "auto" | "raw" },
): Promise<{ text: string; failed: boolean }> {
  const result = await brainWebTool(env).execute(
    {
      url: input.url,
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.format === undefined ? {} : { format: input.format }),
    },
    NO_TURN_API,
    NO_TURN_CONTEXT(30_000),
  );
  return {
    text: (result.output ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n"),
    failed: result.isError === true,
  };
}

/**
 * `agents/webfetch/pi` still returns `content`, which pi-durable renamed to `output` in 1.2.0, so a
 * tool from that package settles with no text: no type error, nothing logged, a blank for the model.
 * Renaming is not enough — the settled result is what gets persisted, so leaving `content` beside
 * `output` would store every fetched page twice. Delete this once upstream returns `output`.
 */
function renamesContentToOutput(tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    execute: async (args, api: ToolExecutionApi, context) => {
      const { content, ...rest } = (await tool.execute(args, api, context)) as ToolExecutionResult & {
        content?: ToolExecutionResult["output"];
      };
      return rest.output === undefined ? { ...rest, output: content } : rest;
    },
  };
}

/** Upstream reads an empty list as "any public host". */
function hostPatterns(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}
