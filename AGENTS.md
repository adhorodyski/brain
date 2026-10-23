# AGENTS.md

[README.md](README.md) is the product and the map. It outranks this file on what Brain is for.

## Rules

**No comments. None.** Not line, block, JSDoc or TODO, and none inside a shell block. Rename or extract until
none are needed. Prose belongs in the README.

**Build only what the README's feature table claims.** Nothing else earns a place: no tests or test runner, no
reminders, alarms or queues, no web fetch, no model call, no transcript, no tenancy or per-user isolation
beyond the `owner` column, no vector search, no UI. `curl` and a real `pi` client against `wrangler dev` answer
every behaviour in seconds, which is why there is no test runner.

**Two runtime deps**, `@modelcontextprotocol/server` and `zod`, and no `nodejs_compat`. Take
`createMcpHandler`, `requireBearerAuth` and `hostHeaderValidationResponse` from the server package. Nothing
from pi.

**Greenfield, always.** `SCHEMA` in `brain.ts` creates the final shape: no `migrate()`, `ALTER`, column guard,
flag, legacy name or default owner. If a change needs one, stop and ask.

## Facts you cannot infer from the code

- `DurableObject` is not a global. Import it from `cloudflare:workers`, or the worker dies at load.
- The verifier throws `OAuthError("invalid_token", …)`, not `Error`, and stamps `expiresAt`. Both are what
  `requireBearerAuth` needs to answer 401 with a challenge instead of 500.
- `dkey` is a hash of the normalised write args plus `owner`, never the JSON-RPC id. Hosts number requests from
  1, so id-keyed dedupe calls one person's note a duplicate of another's. `brain_unlearn` clears the retired
  rule's `dkey`, otherwise re-learning those words reports `again, same call` against an inactive row.
- DDL is an array of statements, each `exec()`'d once, never split on `;`. The FTS triggers hold semicolons, so
  splitting them quietly creates nothing and `recall` returns nothing forever. Those three triggers are the
  whole index sync. Check a schema change with `count(*)` parity between `notes` and `notes_ft`.
- Writes go through `ctx.storage.transactionSync`. A `BEGIN` through `sql.exec` is refused.
- `export` mirrors its JSON into `content` as well as `structuredContent`. Pi shows the structured half only
  when `content` is empty.
- The instruction block is built **after** the write, so `learn` reports the state it caused, and it rides on
  refusals too.
- `brain_learn`'s description is the only nudge a host gets to store a correction. It carries the trigger
  phrases and "call it before answering", so review it in diffs.

## Checks

```sh
npm run check
npx wrangler deploy --dry-run    # 217 KiB gzipped
```

Then, against `wrangler dev`: a missing and an unknown token both give 401 with `WWW-Authenticate`; a query of
`4417` ranks the garage note first; `"`, `((x`, a lone backslash and a blank query never raise
`fts5: syntax error`; a near-miss tag echoes the stored one; the same write twice returns `again, same call`
with one row; another owner's row refuses `forget` by name; a retired rule stops matching searches but stays
in `export`; an over-budget write throws and stores nothing.
