# AGENTS.md

[MEMORY-DESIGN.md](MEMORY-DESIGN.md) is the spec and outranks this file. [README.md](README.md) is setup.

## Rules

**No comments. None** — not line, block, JSDoc or TODO, and none inside a shell block. Rename or extract until a line needs
none; prose belongs in the spec or the README.

**Build only what the spec says**, and nothing its Non-goals list rules out. No tests or test runner: `curl` and `pi`
against `wrangler dev` answer every behaviour in seconds.

**Two runtime deps**, `@modelcontextprotocol/server` and `zod`, no `nodejs_compat`, nothing from pi: take `createMcpHandler`,
`requireBearerAuth` and `hostHeaderValidationResponse` from the server package.

**Greenfield, always.** `SCHEMA` creates the final shape: no `migrate()`, `ALTER`, column guard, flag, legacy name, default
owner. If a change needs one, ask the spec.

## Facts you cannot infer from the code

- `DurableObject` is not a global. Import it from `cloudflare:workers` or the worker dies at load.
- The verifier throws `OAuthError("invalid_token", …)`, not `Error` — the 401 and the `WWW-Authenticate` a host retries come
  from `bearerAuthChallengeResponse` — and it stamps `expiresAt`, which `requireBearerAuth` needs.
- `dkey` is a hash of the normalised write args plus `owner`, never the JSON-RPC id: hosts number requests from 1, so an
  id-keyed dedupe calls another person's note a duplicate. `brain_unlearn` clears the retired rule's `dkey`, or re-learning
  those words reports `again, same call` against an inactive row.
- DDL is an array of statements, each `exec()`'d once, never split on `;` — the FTS triggers hold semicolons, so splitting
  quietly creates nothing and `recall` returns nothing forever. Those triggers are the whole index sync. Creation is
  guarded on `sqlite_master` for `notes`; after a schema change compare `notes` on `count(*)` against `notes_ft`.
- Writes go through `ctx.storage.transactionSync`; a `BEGIN` through `storage.sql.exec` is refused.
- `export` mirrors its JSON into `content` as well as `structuredContent`, because pi shows the structured half to the
  model only when `content` is empty.
- The standing-instruction block rides on every result, refusals included, and is built **after** the write, so `learn`
  reports the state it just caused. `brain_learn`'s description is the only nudge a host gets, so it carries the trigger
  phrases and *call it before answering* — review it in diffs.

## Checks

`npm run check`, `npx wrangler deploy --dry-run` (~218 KiB gzipped; tens more means a dependency crept in), then the spec's
verification table against `wrangler dev`.
