# AGENTS.md

Notes for agents working in this repo. Read [README.md](README.md) for setup.

## House rules

**No code comments unless one records third-party behaviour we cannot change.** A comment that restates
what the next line does is a smell: rename, extract, or type until it is unnecessary, and if renaming
cannot help, write the clearer structure and record nothing. What a reader must know that no construct
can hold lives here, not in the source. What survives in `src/` is exactly that: what pi, `agents`, and
OpenAI-compatible endpoints do (the two notes in `src/web.ts` and the one in `src/model.ts`), the scheduler
note on `MemoryHost.arm`, the Telegram retry note in `src/index.ts`, and the empty-list note in
`src/web.ts`. The whole `Env` interface is uncommented because the README's vars table already says what
every var does — add a var there, not as a doc comment here.

## What this is

One Cloudflare Worker. One Durable Object, `Assistant`, named by `BRAIN_NAME` in `src/tools.ts`. It
hosts a Pi Durable agent through `PiHarness`. Several doors, one conversation thread: Telegram and MCP
today, and a door is only a guard plus a route, so the count is not load-bearing.

## Where things live

| File | Contents |
|---|---|
| `src/index.ts` | The routes (`/health`, `/telegram/webhook`, `/mcp`) and their guards. The Telegram route verifies the webhook secret, allowlists the chat ID, and pushes the turn onto the Agent's durable queue. |
| `src/assistant.ts` | The Agent class. Builds the memory store, installs the tools, owns `PiHarness`, `turnWithin()`, and every door-facing method. The `PiHarness` seam lives here and nowhere else. |
| `src/tools.ts` | `defineTool` definitions for the tools the brain sees, the prompt preamble, `MAX_NOTE`, `WHEN_HELP`, and `BRAIN_NAME`. |
| `src/web.ts` | Cloudflare's `web_fetch` installed for the brain, the same tool run once for the door's `readPage()`, one `webPolicy()` behind both, and `renamesContentToOutput()` to let Cloudflare's adapter run on pi-durable 1.3. |
| `src/store.ts` | Notes and plans in SQLite. Module-scope factory, so the door and the brain read one table. |
| `src/door.ts` | The MCP mount: the tools the bearer token unlocks, and `isTrusted()`. |
| `src/telegram.ts` | `send()`, with the 4096-character split. |
| `src/model.ts` | Declares one provider from the `MODEL_*` vars, which live on the worker rather than in `wrangler.jsonc`. Any OpenAI-compatible endpoint. The `MODEL_ID` you declare is the string sent on the wire. |
| `src/env.d.ts` | The `Env` shape, uncommented by rule. Every var is described in the README's optional vars table or in setup step 4. |
| `scripts/set-webhook.sh` | Sets the Telegram webhook URL and shared secret. |

## Constraints that are easy to get wrong

- **`Agent.sql` is a tagged template**, written as ``this.sql`SELECT ...```, not `(query, values)`. Parameterised and
  ad-hoc statements go through `this.ctx.storage.sql.exec(query, ...values)`, which is what the store's
  `sql` host function wraps.
- **`defineTool` results use `output`, not `content`.** `ToolExecutionResult` names the field the model
  reads `output`; MCP's `CallToolResult` uses `content`, and only `src/door.ts` speaks that shape. The
  adapters in `agents/*/pi` still return `content` — they target pi-durable 1.1 and earlier — so install
  one only through `renamesContentToOutput()` in `src/web.ts`, which renames *and deletes* `content`.
  Renaming alone
  settles the call with no text: no type error, no log, an empty result for the model. Both keys present
  would store every fetched page twice, since the settled result is what gets persisted.
- **`createModels()` takes options, not a provider array.** Use `createModels()` then `setProvider()`.
- **Only `@callable` methods and plain public methods reachable from worker code cross the DO RPC
  boundary.** `stub.memory` is private and cannot be read from `src/door.ts`. That is why the door calls the
  thin methods at the bottom of `Assistant` (`recall`, `remember`, `plan`, `ask`).
- **`this.schedule(when, "callbackName", payload)` takes the callback as a string** naming a method on the
  class. `planFired` is that method.
- **One conversation thread, the root session.** Do not add `sessions.create()` or `fork()`. Every door
  writes that one transcript, which is the whole point of having several of them.
- **A turn outlives whoever asked for it.** `turnWithin()` gives up on `harness.wait` after its budget
  and returns null, which becomes a "still working" reply — the turn itself keeps running and is never
  lost, so asking again reads the same thread and usually answers fast. `operationId` is what makes a
  redelivered request rejoin that turn instead of paying for it twice, so Telegram's `update_id` and a
  fresh `ask`/`plan` UUID are the right keys. Do not make the budget a timeout that aborts the turn.
- **Telegram retries a webhook that stays silent**, long before a brain turn finishes, so
  `src/index.ts` answers 200 first and pushes onto the durable queue. The reply still lands if the
  object is evicted mid-thought. The answer is sent once and never edited afterward.
- **`schedule()` validates before it writes, and deletes its row when arming fails.** A row in `plans`
  with no `schedule_id` behind it lists forever and never fires, and a rejected `at` that wrote its row
  would sit in that list too. Keep both orders.
- **`notes.at` and `plans.at` mean different things** — when a note was stored, and when a plan fires.
  `search` reads the note column back as `storedAt` so the row type says which; keep the alias if you
  touch that query, because SQLite hands back the alias verbatim and a snake_case alias silently
  undefineds the date in every recall line.
- **The `/mcp` entry in a client must carry an `Authorization` header.** Pi treats a URL server with none as an
  OAuth server, caches the `401` from `isTrusted()`, and reports `needs sign-in` for good. This worker serves no
  `/.well-known/oauth-*` document, so that sign-in can never finish. On a mac, the header can be a command
  (`"!echo Bearer $(security find-generic-password -s brain-mcp -w)"`), which keeps the secret out of the file and
  out of every child process's environment. Pi resolves a header command with a 10 second timeout, so nothing that
  waits on a person belongs in one.
- **The `#number` in a recall line is a SQLite `rowid`, and rowids get reused.** Deleting the highest
  note frees its number for the next note written, so a handle read from a stale recall can point at
  unrelated text. That is why `forget` needs the number *and* words from the note itself and refuses
  when the two disagree — it is the guard against a confirmation drifting onto a different note. Do
  not delete on the number alone, and do not make the handle stable by renumbering: that buys nothing
  once the confirm check exists. Keep the refusal on an empty `confirm` too: `text.includes("")` is true
  for every string, so without it a blank `confirm` matches any note and deletes the row the number names.
- **`cancel` matches the id as a suffix and refuses unless exactly one plan ends with it**, quoting every
  candidate when two do. `list` prints the last six characters of a key, so a full key is never in hand; a
  `LIKE '%id'` that deleted every match let one call take out two plans on a short id, and `""` or `"%"`
  let it wipe the table. The guard sits in the store, not only in the tool, so the MCP door cannot walk an
  empty id into it either.

## Decisions worth knowing before you change them

- **Writes from the terminal are direct SQLite writes**, not turns through the brain. That is what keeps a
  note at roughly 80 tokens and stops the brain's transcript growing on every write. Do not route a write
  tool through `ask`.
- **One mount, one token.** `isTrusted()` in `src/door.ts` is a single comparison and `src/index.ts` 401s
  before the handler runs, so the handler never sees an untrusted request. There is no lesser token to
  hand out: `ask` cannot be one, because `PiSubmitOptions` accepts only `session`, `operationId`, and
  `whenBusy` and so cannot restrict a turn's tools. An `ask` answer comes from an agent holding write
  tools whoever asks. If a read-only mount ever returns, it is `recall` and `web_fetch` alone.
- **`MODEL_BASE_URL` and `MODEL_ID` are set outside the repo**, with `wrangler deploy --var NAME:value` or
  in the dashboard, and `wrangler.jsonc` carries `keep_vars: true` so a deploy does not delete them. Drop
  that flag and the next deploy wipes both, after which every call answers `Set these worker vars: ...`
  while `/health` keeps answering 200, so the dashboard looks healthy with a dead brain. Neither value is
  secret, but keeping them off `main` is what makes `wrangler deploy` from a clean checkout safe.
- **`web_fetch` is Cloudflare's, not ours.** `agents/webfetch/pi` brings the fence, the host policy, the
  redirect re-checks, the byte cap, and the windowing, and it is the name models already know. Roll your
  own and you inherit the job of fencing untrusted text again. Conversion runs through the `AI` binding,
  so `wrangler.jsonc` must keep `"ai": { "binding": "AI" }`; format conversion is free and the free tier
  allows 10,000 neurons a day. The door calls the brain's own tool rather than a second fetch path, so
  both doors word a page and a refusal identically and `isError` survives the trip — keep it that way,
  and keep `NO_TURN_API` honest: the adapter takes that argument as `_api` and never reads it.
- **Every tool is `replay: "safe"`.** The tools that write notes and plans are keyed on the call that made it —
  `api.taskId` and `api.callId` form the dedupe key (the key shape borrowed from pi-pocket, MIT), checked
  inside the same transaction as the write — so rerunning one after an eviction changes nothing.
  `forget` is safe without a key: deleting a row that is already gone deletes nothing. `web_fetch` is safe
  for a different reason: it has no effect of ours to redo, and a completed result is
  stored and not refetched. A tool that charges or writes outside this DO must be `replay: "unsafe"`.
- **The tool list is the whole permission model.** Pi Durable has no approval step for tool calls, so
  nothing can widen what the brain does at runtime. `ask` is door-only and runs a full turn; the rest
  are direct SQLite reads and writes or a public fetch. There is no shell, no code execution, and
  no credentials in anyone's accounts. What a page holds reaches the transcript only inside
  `<untrusted_web_content>`, with a nested closing tag escaped, and loopback, private, and link-local
  hosts are refused however `WEB_ALLOWED_HOSTS` reads — so `169.254.169.254` and `localhost` are
  unreachable, which is the difference between reading the web and handing out the worker's own identity.
- **There is no UI and there should not be one.** No ChatStorage, no WebSockets, no AG-UI, no Access. Both
  doors are request/response. `PiHarness` and `session.events()` exist for streaming UIs and are unused.
- **`PiHarness` is beta** and its API may change. Keep the seam inside `src/assistant.ts`.

## Checks

```sh
npm run check                                   # tsc, must stay clean
npx wrangler deploy --dry-run                   # must bundle; watch gzipped size
```

To exercise the doors locally, put values in `.dev.vars`, run `npm run dev`, and drive `/mcp` with curl
using `tools/list` and `tools/call`, which answers with every tool the mount offers. A wrong token should
401 before any tool runs, and `web_fetch` on `http://169.254.169.254/` should come back refused rather
than fetched.
