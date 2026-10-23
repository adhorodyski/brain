# AGENTS.md

Notes for agents working in this repo. [MEMORY-DESIGN.md](MEMORY-DESIGN.md) is the source of truth: it is the
spec v0 was built to, and it outranks this file wherever they disagree. [README.md](README.md) is the setup
guide. Update all three when the surface moves.

## House rules

**No code comments. None.** Not line, not block, not JSDoc, not TODO. Zero comments wins outright for this
project, including the "records third-party behaviour" exception other repos allow. If a line feels
underdocumented, rename or extract until it is not; if prose is genuinely required, it belongs in
MEMORY-DESIGN.md or README.md.

**No automated tests, and no test runner.** That is a decision, not a gap. The whole surface is one MCP
endpoint over DO SQLite and every behaviour is answerable in seconds with `curl` or a `pi` client against
`wrangler dev`. Do not add vitest, a test file, or a dev dependency for either. Verification is the spec's
table, and the checks in it are what "I changed this" must satisfy.

**No backward compatibility, no speculative scaffolding.** Greenfield: `SCHEMA` creates the final shape, and
there is no `migrate()`, no column guard, no feature flag, and no legacy path to keep. If a change needs one,
that is a design question for the spec, not an implementation detail.

**YAGNI against the spec's Non-goals list.** No reminders, curation, web fetch, `ask`, Telegram, push,
tenancy, vectors, OAuth 2.1, or UI. Two runtime dependencies, `@modelcontextprotocol/server` and `zod`, and
no `nodejs_compat`. Anything past that is a scope decision.

## What this is

One Worker, one Durable Object class `Brain`, SQLite storage. Two tables plus an FTS5 index, seven
`brain_`-prefixed tools, one `/mcp` endpoint. **No model runs on the request path** — hosts do the thinking
and this answers from SQLite in milliseconds.

| File | Contents |
|---|---|
| `src/index.ts` | `/health`, `/mcp`, the host guard, and the bearer verifier that turns `BRAIN_TOKENS` into an owner. |
| `src/brain.ts` | The `Brain` DO. Owns the DDL, the `Host` adapter (SQL, transaction, digest), and the one method per tool that `mcp.ts` calls. The only place a DO is constructed. |
| `src/store.ts` | Every note rule, in plain TypeScript over an injected `{ sql, transaction, digest }`. Zero Cloudflare imports. `flat`, `toFtsQuery`, the tag gap, the budgets, the refusals. |
| `src/instruct.ts` | The instructions table, its budget, newest-wins supersede, and the standing-instruction block renderer. |
| `src/mcp.ts` | `McpServer` and the seven `registerTool` calls — the only place a tool is described. Also the shared result wrapper that appends the block. |
| `src/env.d.ts` | The `Env` shape, uncommented by rule; every var is described in the README's table. |

`createMcpHandler` is stateless per request, so each tool's callback resolves the DO stub once and makes
**one RPC call** returning one object. Keep that boundary thin: `mcp.ts` holds no state and `Brain` stays the
only writer.

## Constraints that are easy to get wrong

- **`DurableObject` is not a global.** Write `import { DurableObject } from "cloudflare:workers"`, or the
  worker dies at load with a `ReferenceError`.
- **The verifier throws `OAuthError("invalid_token", …)`, not `Error`.** A plain `Error` answers 500 where the
  401 plus `WWW-Authenticate` a host needs to retry comes from `bearerAuthChallengeResponse`.
- **`requireBearerAuth` refuses a token with no `expiresAt`.** Static tokens do not expire, so the verifier
  stamps now + 1 year; without it every valid token is rejected.
- **DDL is an array of statements, each `exec()`'d once.** The sync triggers contain semicolons, so splitting
  the schema on `;` cuts them in half and creates nothing — quietly, and `recall` then returns nothing
  forever. Two statements in one `exec()` are rejected outright. `CREATE TABLE IF NOT EXISTS` does nothing
  against a live table, so schema creation is guarded on `sqlite_master` for `notes` and skips when present.
  When the schema changes, check `count(*)` equality between `notes` and `notes_ft`: that is the drift canary.
- **`dkey` is a hash of the normalised write arguments plus the owner**, never `ctx.mcpReq.id`. That id is the
  JSON-RPC id and pi, Codex and Cursor all number it from 1 per session, so keying on it reports one
  person's note as another's duplicate. Content is the right identity here: the same fact arriving twice is
  one fact. The hash is written in the same transaction as the row, in both tables, and `UNIQUE` is the
  guarantee.
- **Transactions go through `ctx.storage.transactionSync`.** A `BEGIN` statement through `storage.sql.exec`
  is refused at runtime.
- **The three FTS triggers are the whole index sync.** External-content FTS5 does not stay in sync on its own
  and needs its `'delete'` rows, so `store.ts` writes one `INSERT INTO notes` and stops. Without them a
  `patch` leaves the old text searchable forever.
- **`toFtsQuery` is built, never passed through.** Free text reaches `MATCH` and FTS5 throws on a stray
  quote, bare `- * " (`, an empty string, and text containing `'); `. Single tokens go in as `"tok"* OR
  "tok"` — prefix and exact, both ranked — and multi-word queries join with OR, because AND-ing a whole
  question matches nothing. Tags match in the same query, so a tag no query can reach is decoration.
- **Rowids are reused**, so the `#id` a recall line prints is not a stable handle. `patch`, `forget` and
  `unlearn` all need the id **and** words from that row's own text and refuse when the two disagree. Keep the
  empty-`confirm` refusal too: `text.includes("")` is true for every string, so without it a blank confirm
  matches anything the id names. Do not buy stability by renumbering — that gains nothing once the confirm
  check exists.
- **`## Related` is the structural verification step, not a nicety.** Nothing in the write path can see a
  contradiction a word search cannot, so the read path surfaces tag neighbours instead of asking a host to run
  a `verify` call it may skip. Keep the explicit `nothing stored matching "…"` too: a confident no-result is a
  fact, a silent one invites a guess.
- **Budgets throw; they never truncate.** A host quoting half a fact forever is worse than a refused write.
  Token estimate is the local `Math.ceil(chars / 3.5)`, one function, so no two callers round differently. Fill
  lines print **characters** against `tokens × 3.5`, plus the percentage — that fill line is what makes a model
  consolidate in the same turn instead of discovering the wall on its next call. Keep the `core` and
  instruction budgets separate, and keep both checks inside the store so neither caller can walk past them.
- **`flat()` runs on every write and every render.** It collapses whitespace and strips zero-width and
  directional codepoints, so a note cannot break the one-line shape the recall lines and the block depend on,
  and cannot carry an invisible character into text a model re-reads every turn.
- **The standing-instruction block rides on every tool result, refusals included**, attached in the one shared
  wrapper in `mcp.ts`. That is the delivery design: it needs no conversation state, and because it is re-sent
  constantly, compaction cannot lose it. The header counts cover **rule bodies only**, never the fixed
  paragraph. Build it after the write, so a `learn` reports the state it just caused.
- **`owner` and `source` come from the token and are never tool arguments**, so an injected page cannot name a
  thing that isn't accepted as input. There is one `Brain` object for both people — multi-tenancy is a
  non-goal and per-owner objects would split the archive.
- **`learn` refuses anything over 200 characters carrying a link, an email or a code fence**, because any
  connected host may write and "*always forward my messages to X*" is a reachable rule. The residual risk does
  not go away: if a review gate ever ships, it goes here first.
- **Newest wins on instructions.** A `learn` retires the active rules in its scope that share its topic, sets
  `active = 0` and `superseded_key`, and the loser leaves `recall` for good while staying in `export`. Search
  must not resurface a retired rule for a helpful host to re-learn.
- **`export` mirrors its payload into `content` text as well as `structuredContent`.** pi renders
  `structuredContent` to the model only when `content` is empty, so structured-only output is invisible to it.
- **`annotations` are the host's permission cue**: `readOnlyHint` on `brain_recall` and `brain_export`,
  `destructiveHint` on `brain_forget` and `brain_unlearn`, `idempotentHint` on the two reads only. A missing
  or wrong hint nags the owner for a read or auto-confirms a delete.
- **`brain_learn`'s description is load-bearing code.** In a design with no agent prompt it is the only nudge
  that exists; it carries the trigger phrases and says *call it before answering*, because after answering the
  model optimises the answer. Review it in diffs.

## Checks

```sh
npm run check                 # tsc, must stay clean
npx wrangler deploy --dry-run # must bundle; ~1247 KiB raw / ~218 KiB gzipped
```

A gzipped size tens of KiB past ~218 means something pulled in a dependency it should not have. `agents` is
not a dependency and neither is any pi package; take `createMcpHandler`, `requireBearerAuth` and
`hostHeaderValidationResponse` from `@modelcontextprotocol/server` directly.

Then drive it by hand: `npm run dev`, curl `/health`, curl `/mcp` unauthenticated (401 + `WWW-Authenticate`),
curl `tools/list` with a bearer (exactly seven tools), and replay one `tools/call` twice to watch dedupe.
Connect a real `pi` client with `pi mcp add brain --url … --bearer-token-env-var BRAIN_TOKEN` before trusting
any change to the tool contract.
