# AGENTS.md

[README.md](README.md) is the product. It is also the scope: Brain does what its feature table claims and
nothing else.

## Where things live

| File | Contents |
|---|---|
| `src/index.ts` | `GET /health`, `POST /mcp`, host-header guard, Cloudflare Access identity guard |
| `src/brain.ts` | The Durable Object: schema on init, one method per tool, and the recall assembly that puts facts and rules in one response |
| `src/mcp.ts` | `McpServer`, the seven tool definitions, descriptions, annotations, and the shared wrapper that turns a reply into a result. The only place a tool is defined |
| `src/store.ts` | All note SQL: the note cap, `dkey` dedupe, tag convergence, text flattening, FTS query. No Cloudflare or MCP imports |
| `src/rules.ts` | Rule rows: the rule-length and content gates, the required topics, supersede by identical wording, tombstones, the matching query, and the authority paragraph |
| `src/env.d.ts` | `Env` |

## Rules

**No comments. None.** Not line, block, JSDoc or TODO, and none inside a shell block. Rename or extract until
none are needed. Prose belongs in the README.

**Nothing beyond the README's feature table earns a place.** No test runner, no reminders, alarms or queues,
no web fetch, no model call, no transcript, no second user or per-row ownership, no vector search, no UI.

**No `nodejs_compat`. Nothing from pi.**

**Greenfield.** `SCHEMA` in `brain.ts` creates the final shape. No `migrate()`, `ALTER`, column guard, flag,
legacy name or default value for a dropped column. If a change seems to need one, stop and ask. Every
statement in `SCHEMA` carries `IF NOT EXISTS`, which is what lets a deployed DO that already has `notes` gain
`rules` and `rules_ft` without touching its rows. That is the one exception the rule allows, and it is the
reason `ensureSchema` checks both table names rather than `notes` alone.

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
- Nothing is injected. There is no standing block, and no tool result carries rules the query did not earn.
  The authority paragraph rides only under a non-empty `instructions` section, and the `brain_learn` nudge
  lives there too. Re-adding a block to every result looks like a small robustness win and is what this
  product deleted: it rode on every call whatever the call was about, compaction dropped it, and it was
  demonstrably ignored while present.

- `fill()` is built **after** the insert. Build it before and `brain_learn` reports a count from before its
  own row existed.

- `recall` runs two SELECTs with their own limits and concatenates them. Do not UNION the tables into one
  ranked list. BM25 divides by document length and the tags column is weighted above the text column, so the
  one-sentence rules would outscore the long notes and take slots from the garage note. Keep
  `rules_ft` separate even though it holds the same two column shapes.

- `rules.match` filters `active = 1` in SQL. Drop the predicate and a retired rule keeps matching searches,
  which is the failure `brain_forget` cannot have because `forget` deletes the row.

- Supersede matches on **wording**, not topic: `sameWords` compares the two sorted word lists. A retired rule
  matches nothing ever again, so anything that over-fires silently deletes behaviour. Firing on a shared topic
  did exactly that with the owner's own rules: three distinct coding rules went in one after another and one
  survived, and the write answered `stored · 1 of 3 · superseded r#2`, which reads as bookkeeping. Topics are
  free text chosen by a model, so overlap is the normal case and cannot be the signal. Retire by hand with
  `brain_unlearn`.

- A rule needs topics, and `learn` refuses without them. Topics are the filing label; retrieval runs on the
  rule's own text, because `toFtsQuery` quotes exact tokens with no stemming, so a rule tagged `writing` is
  missed by "write the release notes". A rule that must fire on prose work has to say `writing`, `replies`,
  or `summaries` in its own text.

- The empty-recall line is load-bearing prose. `nothing stored matching "x"` alone reads as a failed lookup,
  so the host calls `brain_export` for the whole archive — twice the payload, because `outputSchema` sends it
  in `content` and `structuredContent`. The line has to claim the miss survives **another query**: wording it
  about one question invites rephrasing, and a host that rephrases enough dumps anyway. Even worded this way
  about one run in fifteen still dumps. That is host behaviour, not wording still to be found — do not read a
  lone dump as a regression, and do not trim the sentence, which looks cosmetic and brings the dumps back.
  `recall` prints it only when **both** indexes come back empty. Facts missing and a rule matching is not a
  miss, and printing the line there both claims something false about the archive and suppresses the one path
  that worked.

- The `r#id` that `brain_recall` and `brain_learn` print is the only place a host gets an instruction id.
  Remove it and `brain_unlearn` needs an export to find its
  target — the pointer in the not-found error was never the cause, the hidden id was. Notes print `#id` and
  rules print `r#id` so one number can never name a row in the wrong table.

- The supersede `UPDATE` clears `dkey` with `active = 0`, the way `brain_unlearn` does. Leave `dkey` populated
  and re-learning a rule that supersede retired hits the dedupe check before the supersede loop: the answer is
  `stored · again, same call` and the rule stays retired. That line there is the bug, not a healthy retry.

## Checks

```sh
npm run check
npx wrangler deploy --dry-run
```

Then against `wrangler dev`, with a real `pi` client for the tools and `curl` for the rest: with the
`access.dev` block removed `/mcp` gives 403 `Access required` and not 500; against the deployed Worker, an
unauthenticated `/mcp` gives 401 with `WWW-Authenticate` from Access, not from this Worker; a query of `4417`
ranks the garage note first; `"`, `((x`, a lone backslash, `"OR"` and a blank query never raise `fts5: syntax
error`; a near-miss tag echoes the stored one, and so does a near-miss topic; the same write twice returns
`again, same call` with one row; a retired rule stops matching searches but stays in `export`; a note over
`MAX_NOTE` throws and stores nothing.

Two checks belong to the pull-only design and neither has a plausible-looking edit that keeps it passing.
A query holding only a rule's own words returns that rule under `instructions` with the authority paragraph
under it. And no tool result mentions a rule it did not match: `brain_patch`, `brain_forget`, `brain_remember`
and `brain_export` return only their own line, and `brain_recall` of a fact-only query carries no authority
paragraph. Grep the raw output for `Standing instructions` and for `outrank` rather than reading it, because
a restored footer reads fine and charges every turn for rules the turn did not ask for.

Supersede gets its own three-write check, because the failure is silent and the answer text looks healthy.
Store three rules with different wording that all carry the topic `coding`: all three must come back from a
`coding` query. Then store the first rule's exact wording with different topics: it must answer
`superseded r#1` and leave the other two live. A shared-topic rule leaves you with one live rule and no
error, which is the bug and not a policy.

Then ask `pi`, over ~15 runs, for a fact that
was never stored: it answers "I don't know", takes 0-2 recalls, and `brain_export` fires in about one run of
fifteen. Ask it to retire a rule by name and it takes the `r#id` from a recall. Over the same ~15 runs, ask
for work in each task class (tests, a pull request, prose) without naming Brain at all, and count how many
sessions call `brain_recall` unprompted. That count is the whole delivery mechanism now: a class that rarely
triggers is a description that has to name it, not a block to put back.
