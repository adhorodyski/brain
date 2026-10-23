# AGENTS.md

[README.md](README.md) is the product. It is also the scope: Brain does what its feature table claims and
nothing else.

## Where things live

| File | Contents |
|---|---|
| `src/index.ts` | `GET /health`, `POST /mcp`, host-header guard, single-token guard |
| `src/brain.ts` | The Durable Object: schema on init, one method per tool, and the instruction block built after each write |
| `src/mcp.ts` | `McpServer`, the seven tool definitions, descriptions, annotations, and the shared wrapper that attaches the block to every result. The only place a tool is defined |
| `src/store.ts` | All note SQL: budgets, `dkey` dedupe, tag convergence, text flattening, FTS query. No Cloudflare or MCP imports |
| `src/instruct.ts` | Instruction rows: the 200-character gate, supersede, tombstones, block renderer |
| `src/env.d.ts` | `Env` |

## Rules

**No comments. None.** Not line, block, JSDoc or TODO, and none inside a shell block. Rename or extract until
none are needed. Prose belongs in the README.

**Nothing beyond the README's feature table earns a place.** No test runner, no reminders, alarms or queues,
no web fetch, no model call, no transcript, no second user or per-row ownership, no vector search, no UI.

**Two runtime deps**, `@modelcontextprotocol/server` and `zod`, and no `nodejs_compat`. Nothing from pi.

**Greenfield.** `SCHEMA` in `brain.ts` creates the final shape. No `migrate()`, `ALTER`, column guard, flag,
legacy name or default value for a dropped column. If a change seems to need one, stop and ask.

## Traps

These four are correct in the code today. Each has a plausible-looking edit that breaks it quietly.

- Splitting the DDL string on `;` destroys the FTS triggers, which contain semicolons. Statements go through
  `exec()` one at a time. The failure is silent: the worker boots and `recall` returns nothing forever.
- Throwing a plain `Error` from the token verifier answers 500 instead of 401. It needs `OAuthError`, plus the
  `expiresAt` stamp, and hosts then retry instead of treating the endpoint as down.
- `dkey` hashes the normalised write args, not the JSON-RPC id. Hosts number requests from 1 per session, so an
  id-keyed dedupe collides across clients and reports a fresh write as a duplicate.
- The instruction block is built **after** the write. Build it before and `brain_learn` reports the fill state
  from before its own row existed.

## Checks

```sh
npm run check
npx wrangler deploy --dry-run
```

The dry-run bundles at 217 KiB gzipped. Tens more means a dependency crept in.

Then against `wrangler dev`, with a real `pi` client for the tools and `curl` for the rest: a missing or
unknown token gives 401 with `WWW-Authenticate`; a query of `4417` ranks the garage note first; `"`, `((x`, a
lone backslash and a blank query never raise `fts5: syntax error`; a near-miss tag echoes the stored one; the
same write twice returns `again, same call` with one row; a retired rule stops matching searches but stays in
`export`; an over-budget write throws and stores nothing.
