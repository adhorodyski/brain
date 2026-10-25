# AGENTS.md

[README.md](README.md) is the product. It is also the scope: Brain does what its feature table claims and
nothing else.

## Where things live

| File | Contents |
|---|---|
| `src/index.ts` | `GET /health`, `POST /mcp`, host-header guard, Cloudflare Access identity guard |
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

Each of these has a plausible-looking edit that breaks it quietly.

- Splitting the DDL string on `;` destroys the FTS triggers, which contain semicolons. Statements go through
  `exec()` one at a time. The failure is silent: the worker boots and `recall` returns nothing forever.
- The identity guard is `ctx.access?.getIdentity()`, and the `?.` is load-bearing. `ctx.access` is undefined
  whenever Access did not authenticate the invocation — Access switched off, a hostname it does not cover, or
  `wrangler dev` with no `access.dev` block. Drop the `?.` and those requests throw a TypeError and answer 500,
  which hosts read as the endpoint being down; keep it and they answer 403 and go sign in.
- `access.dev.identity` in `wrangler.jsonc` is what gives `wrangler dev` an identity, and `access.dev.aud`
  beside it is required by wrangler even though no code reads `ctx.access.aud`. Drop `identity` and dev 403s;
  drop `aud` and dev refuses to boot; delete the block and dev 403s like a Worker with no Access rule.
- `dkey` hashes the normalised write args, not the JSON-RPC id. Hosts number requests from 1 per session, so an
  id-keyed dedupe collides across clients and reports a fresh write as a duplicate.
- The instruction block is built **after** the write. Build it before and `brain_learn` reports the fill state
  from before its own row existed.

- The empty-recall line is load-bearing prose. `nothing stored matching "x"` alone reads as a failed lookup,
  so the host calls `brain_export` for the whole archive — twice the payload, because `outputSchema` sends it
  in `content` and `structuredContent`. The line has to claim the miss survives **another query**: wording it
  about one question invites rephrasing, and a host that rephrases enough dumps anyway. Even worded this way
  about one run in fifteen still dumps. That is host behaviour, not wording still to be found — do not read a
  lone dump as a regression, and do not trim the sentence, which looks cosmetic and brings the dumps back.

- The `#id` in the instructions block is the only place a host gets an instruction id. Remove it and
  `brain_unlearn` needs an export to find its target — the pointer in the not-found error was never the cause,
  the hidden id was.

- The supersede `UPDATE` clears `dkey` with `active = 0`, the way `brain_unlearn` does. Leave `dkey` populated
  and re-learning a rule that supersede retired hits the dedupe check before the supersede loop: the answer is
  `stored · again, same call` and the rule stays retired. That line there is the bug, not a healthy retry.

## Checks

```sh
npm run check
npx wrangler deploy --dry-run
```

The dry-run bundles at 217 KiB gzipped. Tens more means a dependency crept in.

Then against `wrangler dev`, with a real `pi` client for the tools and `curl` for the rest: with the
`access.dev` block removed `/mcp` gives 403 `Access required` and not 500; against the deployed Worker, an
unauthenticated `/mcp` gives 401 with `WWW-Authenticate` from Access, not from this Worker; a query of `4417`
ranks the garage note first; `"`, `((x`, a
lone backslash and a blank query never raise `fts5: syntax error`; a near-miss tag echoes the stored one; the
same write twice returns `again, same call` with one row; a retired rule stops matching searches but stays in
`export`; an over-budget write throws and stores nothing. Then ask `pi`, over ~15 runs, for a fact that was
never stored: it answers "I don't know", takes 0-2 recalls, and `brain_export` fires in about one run of
fifteen. Ask it to retire a rule by name and it takes the id from the instructions block.
