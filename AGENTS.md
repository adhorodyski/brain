# AGENTS.md

Notes for agents working in this repo. Read [README.md](README.md) for setup.

## What this is

One Cloudflare Worker. One Durable Object, `Assistant`, named by the `BRAIN` constant in `src/tools.ts`. It
hosts a Pi Durable agent through `PiHarness`. Two doors, one conversation thread.

## Where things live

| File | Contents |
|---|---|
| `src/index.ts` | The three routes (`/health`, `/telegram/webhook`, `/mcp`) and both guards. The Telegram route verifies the webhook secret, allowlists the chat ID, and pushes the turn onto the Agent's durable queue. |
| `src/assistant.ts` | The Agent class. Builds the memory store, installs the tools, owns `PiHarness`, `turn()`, and every door-facing method. The `PiHarness` seam lives here and nowhere else. |
| `src/tools.ts` | `defineTool` definitions for the four tools the brain sees, the prompt preamble, `BRAIN_NAME`, `WHEN_HELP`, and `defang`. |
| `src/store.ts` | Notes and plans in SQLite. Module-scope factory, so the door and the brain read one table. |
| `src/door.ts` | The MCP mount, and the choice of which tools a bearer token unlocks. |
| `src/telegram.ts` | `send()`, with the 4096-character split. |
| `src/model.ts` | Declares one provider from `MODEL_*` vars. Any OpenAI-compatible endpoint. The `MODEL_ID` you declare is the string sent on the wire. |
| `src/env.d.ts` | The `Env` shape. Every var and secret is declared here. |
| `scripts/set-webhook.sh` | Sets the Telegram webhook URL and shared secret. |

## Constraints that are easy to get wrong

- **`Agent.sql` is a tagged template**, written as ``this.sql`SELECT ...```, not `(query, values)`. Parameterised and
  ad-hoc statements go through `this.ctx.storage.sql.exec(query, ...values)`, which is what the store's
  `sql` host function wraps.
- **`defineTool` results use `output`, not `content`.** `ToolRegistration.execute` returns
  `ToolExecutionResult`. MCP's `CallToolResult` uses `content`, and only `src/door.ts` speaks that shape.
- **`createModels()` takes options, not a provider array.** Use `createModels()` then `setProvider()`.
- **Only `@callable` methods and plain public methods reachable from worker code cross the DO RPC
  boundary.** `stub.memory` is private and cannot be read from `src/door.ts`. That is why the door calls the
  thin methods at the bottom of `Assistant` (`recall`, `remember`, `plan`, `page`, `ask`, `forget`).
- **`this.schedule(when, "callbackName", payload)` takes the callback as a string** naming a method on the
  class. `planFired` is that method.
- **One conversation thread, the root session.** Do not add `sessions.create()` or `fork()`.

## Decisions worth knowing before you change them

- **Writes from the terminal are direct SQLite writes**, not turns through the brain. That is what keeps a
  note at roughly 80 tokens and stops the brain's transcript growing on every write. Do not route a write
  tool through `ask`.
- **Two mounts, one handler.** `mountFor()` in `src/door.ts` maps a bearer token to `trusted` or
  `read-only`; the factory registers a different tool list per request. `read-only` is `recall` alone.
- **`ask` is never read-only.** `PiSubmitOptions` accepts only `session`, `operationId`, and `whenBusy`, so
  a turn's tools cannot be restricted. An `ask` answer comes from an agent holding write tools regardless of
  who called it.
- **Every tool is `replay: "safe"` because each is keyed on the call that made it.** `api.taskId` and
  `api.callId` form the dedupe key, checked inside the same transaction as the write. A future tool with an
  outside effect must be `replay: "unsafe"`.
- **`fetch_page` fences its output.** Untrusted text enters a durable transcript with no approval step, so
  `defang` (copied from pi-pocket, MIT) neutralises `<` before `/` including invisible-character evasion,
  and the result is wrapped in `<fetched>`, which the preamble declares to be data.
- **There is no UI and there should not be one.** No ChatStorage, no WebSockets, no AG-UI, no Access. Both
  doors are request/response. `PiHarness` and `session.events()` exist for streaming UIs and are unused.
- **No side-effecting tools.** No bash, no shell, no code execution, no account credentials. Pi Durable has
  no approval step for tool calls yet, so a narrow tool list is the permission layer.
- **`PiHarness` is beta** and its API may change. Keep the seam inside `src/assistant.ts`.

## Checks

```sh
npm run check                                   # tsc, must stay clean
npx wrangler deploy --dry-run                   # must bundle; watch gzipped size
```

To exercise the doors locally, put values in `.dev.vars`, run `npm run dev`, and drive `/mcp` with curl
using `tools/list` and `tools/call`. A read-only token should list `recall` alone and should not reach
`remember` or `forget`.
