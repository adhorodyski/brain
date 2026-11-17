# AGENTS.md

[README.md](README.md) is the product. It is also the scope: Brain does what its feature table claims and
nothing else.

## Where things live

| File | Contents |
|---|---|
| `src/index.ts` | `GET /health`, `POST /mcp`, host-header guard, Cloudflare Access identity guard |
| `src/db.ts` | The only file that names D1: one `run(statements)` that sends a whole batch, plus `s`, `rowsOf` and `rowOf`. `digest` lives here |
| `src/brain.ts` | `createBrain`: one method per tool, and the recall assembly that puts notes and rules in one response |
| `src/mcp.ts` | `McpServer`, the seven tool definitions, descriptions, annotations, and the shared wrapper that turns a reply into a result. The only place a tool is defined |
| `src/notes.ts` | All note SQL: the note cap, `dkey` dedupe, tag convergence, text flattening, FTS query. No Cloudflare or MCP imports |
| `src/rules.ts` | Rule rows: the rule-length and content caps, the required tags, supersede by identical wording, the matching query, and the authority paragraph |
| `migrations/NNNN_name.sql` | The shape of the database, one committed file per change. Applied by `npm run migrate` |
| `tools/export-to-migration.mjs` | Turns a `brain_export` file into an import migration that restores ids, timestamps, retirement and dedupe keys |
| `src/env.d.ts` | `Env` |

## Rules

**No comments. None.** Not line, block, JSDoc or TODO, and none inside a shell block. Rename or extract until
none are needed. Prose belongs in the README.

**Nothing beyond the README's feature table earns a place.** No test runner, no reminders, alarms or queues,
no web fetch, no model call, no transcript, no second user or per-row ownership, no vector search, no UI.

**No `nodejs_compat`. Nothing from pi.**

**The shape lives in `migrations/`, and nothing at boot touches it.** A schema change is a new committed
`.sql` file that you apply with `npm run migrate` before you deploy, so the schema is never behind the code
reading it. Files are append-only: never edit one that has been applied, and never add runtime DDL to `src/`.
Every `CREATE` in a new file still carries `IF NOT EXISTS`, so a fresh database and a migrated one end up
identical. A file runs as one transaction: if any statement fails the whole file rolls back and
`d1_migrations` records nothing, so fix the file and re-apply it against the same rows.

Structural change that SQLite cannot do in place — a rename, a type, a new search column — is the
create-copy-swap-rebuild sequence, and it belongs in one file. `brain_export` plus
`tools/export-to-migration.mjs` is the other door: when a rebuild is uglier than a re-import, export, generate,
apply. D1 keeps 30 days of history on paid plans, which is the undo for either.

## Traps

Each of these has a plausible-looking edit that breaks it quietly.

- **`brain_patch` already defeats dedupe on a note.** It stores `dkey` over the note id and the confirm
  fragment, so the stored key depends on words that are not in the note. Re-member a patched note's own text
  and the DO answers `stored #<new id>` and adds a row: measured on `main`, `patched #1` then re-remembering
  the new text stored `#3`. So an exported `dkey` is not worth preserving, and `export-to-migration.mjs`
  derives keys from content by default (`notes`: `digest([text, tags])`, `rules`: `digest([tags, text])`,
  retired rules `NULL`). An import that way *repairs* the patched notes. `--keep-keys` is the only reason to
  carry the old ones, and `d1_migrations` plus 30 days of history is the undo for either.
  This is also why an export from a build that predates `dkey` is a complete migration and not a lossy one:
  both shapes generate the same SQL.

- A migration that touches the search index has to drop and rebuild it, and **`DROP TABLE notes_ft` does not
  drop `notes_ai`, `notes_au` or `notes_ad`, because those triggers are declared `ON notes`.** Drop the
  triggers first or the recreate dies with `trigger notes_ai already exists`. And editing the
  `CREATE VIRTUAL TABLE IF NOT EXISTS` line alone is worse than doing nothing: on a database that already has
  the narrower index it is a silent no-op, so new installs get the new column and the deployed brain never
  does, and `recall` quietly stops matching it. A widening file is `DROP TRIGGER` x3, `DROP TABLE`,
  `CREATE VIRTUAL TABLE`, `CREATE TRIGGER` x3, `INSERT INTO notes_ft(notes_ft) VALUES ('rebuild')`.

- The `bm25(notes_ft, 1.0, 5.0)` weight list is **positional per FTS column**, in `notes.ts` and `rules.ts`
  separately from the `CREATE VIRTUAL TABLE`. Add a column to the index and forget the list and SQLite does
  not complain; it either scores with the wrong weights or answers `database disk image is malformed`. The
  count of weights and the count of indexed columns are one fact held in two files.

- **`meta.changes` from a D1 `batch()` is not a per-statement row count.** Measured: in a three-item batch the
  middle item was a skipped `ON CONFLICT DO NOTHING` and reported `changes: 4`. So no guard in this codebase
  may decide anything from `changes` or `last_row_id`. `forget`, `patch` and the dedupe in `remember` all
  state their business in the `WHERE` clause (`instr(text, ?) > 0`) and then **confirm the outcome with a
  `SELECT` in the same batch**: the row is gone, the text now reads what was written, the `dkey` was already
  there. `db.ts` deliberately exposes no `changes` field so this is not available to reach for.

- One `run()` is one `batch()`, which D1 documents as a transaction: all statements commit together or none
  do. That is what replaced `transactionSync`, and it is why every read that a write depends on is *inside*
  the same batch rather than a `run()` before it. Splitting such a pair into two `run()` calls is the edit
  that breaks it quietly: another request can land in between.
- The identity guard is `ctx.access?.getIdentity()`, and the `?.` is load-bearing. `ctx.access` is undefined
  whenever Access did not authenticate the invocation — Access switched off, a hostname it does not cover, or
  `wrangler dev` with no `access.dev` block. Drop the `?.` and those requests throw a TypeError and answer 500,
  which hosts read as the endpoint being down; keep it and they answer 403 and go sign in.
- `access.dev.identity` in `wrangler.jsonc` is what gives `wrangler dev` an identity, and `access.dev.aud`
  beside it is required by wrangler even though no code reads `ctx.access.aud`. Drop `identity` and dev 403s;
  drop `aud` and dev refuses to boot; delete the block and dev 403s like a Worker with no Access rule.
- `dkey` hashes the normalised write args, not the JSON-RPC id. Hosts number requests from 1 per session, so an
  id-keyed dedupe collides across clients and reports a fresh write as a duplicate. It is also part of what
  `brain_export` returns, because it cannot be recomputed: `patch` stores a key over the note's id and the
  confirm fragment, words the export does not carry. Drop it from the export or from the import migration and
  a restored brain answers a repeat write with `stored #<new id>` instead of `again, same call`, quietly
  doubling rows.
- Nothing is injected. There is no standing block, and no tool result carries rules the query did not earn.
  The authority paragraph rides only under a non-empty `rules` section, and the sentence telling you to call
  `brain_learn` lives there too. Re-adding a block to every result looks like a small robustness win and is what this
  product deleted: it rode on every call whatever the call was about, compaction dropped it, and it was
  demonstrably ignored while present.

- `counts()` reads happen **after** the insert and the retires, in the same batch. Put them first and
  `brain_learn` reports a count from before its own row existed.

- `recall` runs two SELECTs with their own limits and concatenates them. Do not UNION the tables into one
  ranked list. BM25 divides by document length and the tags column is weighted above the text column, so the
  one-sentence rules would outscore the long notes and take slots from the garage note. Keep
  `rules_ft` separate even though it holds the same two column shapes.

- `rules.match` filters `active = 1` in SQL. Drop the predicate and a retired rule keeps matching searches,
  which is the failure `brain_forget` cannot have because `forget` deletes the row.

- Supersede matches on **wording**, not tag: `sameWords` compares the two sorted word lists. A retired rule
  matches nothing ever again, so anything that over-fires silently deletes behaviour. Firing on a shared tag
  did exactly that with the owner's own rules: three distinct coding rules went in one after another and one
  survived, and the write answered `stored · 1 of 3 · superseded r#2`, which reads as bookkeeping. Tags are
  free text chosen by a model, so overlap is the normal case and cannot be the signal. Retire by hand with
  `brain_unlearn`.

- A rule needs tags, and `learn` refuses without them. Tags are the filing label; retrieval runs on the
  rule's own text, because `toFtsQuery` quotes exact tokens with no stemming, so a rule tagged `writing` is
  missed by "write the release notes". A rule that must fire on prose work has to say `writing`, `replies`,
  or `summaries` in its own text.

- The empty-recall line is load-bearing prose. `nothing stored matching "x"` alone reads as a failed lookup,
  so the host calls `brain_export` for the whole brain — twice the payload, because `outputSchema` sends it
  in `content` and `structuredContent`. The line has to claim the miss survives **another query**: wording it
  about one question invites rephrasing, and a host that rephrases enough dumps anyway. Even worded this way
  about one run in fifteen still dumps. That is host behaviour, not wording still to be found — do not read a
  lone dump as a regression, and do not trim the sentence, which looks cosmetic and brings the dumps back.
  `recall` prints it only when **both** indexes come back empty. Notes missing and a rule matching is not a
  miss, and printing the line there both claims something false about the brain and suppresses the one path
  that worked.

- The `r#id` that `brain_recall` and `brain_learn` print is the only place a host gets a rule id.
  Remove it and `brain_unlearn` needs an export to find its
  target — the pointer in the not-found error was never the cause, the hidden id was. Notes print `#id` and
  rules print `r#id` so one id can never name a row in the wrong table.

- The supersede `UPDATE` clears `dkey` with `active = 0`, the way `brain_unlearn` does. Leave `dkey` populated
  and re-learning a rule that supersede retired hits the dedupe check before the supersede loop: the answer is
  `stored · again, same call` and the rule stays retired. That line there is the bug, not a healthy retry.

- **`migrations/*_import.sql` is gitignored on purpose**, and it is the one migration file that must stay
  that way: an import generated from `brain_export` is the owner's whole memory in plain text, and this repo is
  public. Wrangler reads the directory from disk, so ignoring costs nothing. A committed `INSERT INTO notes`
  of anyone's real note is not a fixture; generate one if a test needs rows.

## Checks

```sh
npm run check
npm run migrate                     # against the real database, after reviewing the new file
npx wrangler deploy --dry-run
```

The suites are `./tools-run-check.sh <name>`, each against its own fresh `wrangler dev` with `migrations/`
applied first, so the schema a test exercises is the schema a deploy gets. `behaviour` (38) is the whole
tool contract; `schema` (6) proves a migrated database answers both indexes; `guards` (16) proves a refused
write stays refused; then `caps`, `fractional`, `tiebreak`. `tagscan` carries one known failure inherited from
before the move to D1 and it is still a real failure, not a pass to be written off.

Then by hand, with `curl` for the non-tool paths: with the `access.dev` block removed `/mcp` gives 403
`Access required` and not 500; against the deployed Worker, an unauthenticated `/mcp` gives 401 with
`WWW-Authenticate` from Access, not from this Worker.

Two of these have no plausible-looking edit that keeps them passing, because both fail silently.

**A widening migration must be proved against a database that already holds rows.** Seed a `rules` table whose
`rules_ft` indexes only `text` and `tags`, put a row in it, then apply the file that adds a column and widens
the index. The existing row must still be findable by its old words **and** findable by the new column, and
the stored `bm25` weight list must have grown to match. Apply only the changed `CREATE VIRTUAL TABLE` line on
its own and the file succeeds while the deployed index stays narrow: that is the bug, and a check that only
asks whether `rules_ft` answers *a* query will report it as healthy.

**A migration must be proved to roll back.** Put a bad statement in the middle of a file that adds a column,
apply it, and confirm the column is absent, the earlier statements left nothing behind, and `d1_migrations`
has no row for that file. Then fix the statement and re-apply against the same rows: the rows must be there
still and the file must succeed. Verified by hand against a real remote database on 2026-11-16, where a
collision on `notes_ai` left the schema exactly as it was and the ledger empty.

The rest belongs to the pull-only design. A query holding only a rule's own words returns that rule under
`rules` with the authority paragraph under it. And no tool result mentions a rule it did not match:
`brain_patch`, `brain_forget`, `brain_remember` and `brain_export` return only their own line, and
`brain_recall` of a note-only query carries no authority paragraph. Grep the raw output for
`Standing instructions` and for `outrank` rather than reading it, because a restored authority paragraph reads
fine and charges every turn for rules the turn did not ask for.

Supersede gets its own three-write check, because the failure is silent and the answer text looks healthy.
Store three rules with different wording that all carry the tag `coding`: all three must come back from a
`coding` query. Then store the first rule's exact wording with different tags: it must answer
`superseded r#1` and leave the other two unretired. A shared-tag rule leaves you with one rule and no
error, which is the bug and not a policy. `behaviour` runs all of it, and adds the batch cases: a three-item
`brain_remember` with a dupe in the middle stores the two new notes, names the row that already holds the
middle one, and adds no fourth row to the export.

Then ask `pi`, over ~15 runs, for a note that
was never stored: it answers "I don't know", takes 0-2 recalls, and `brain_export` fires in about one run of
fifteen. Ask it to retire a rule by name and it takes the `r#id` from a recall. Over the same ~15 runs, ask
for work in each task class (tests, a pull request, prose) without naming Brain at all, and count how many
sessions call `brain_recall` unprompted. That count is the whole delivery mechanism now: a class that rarely
triggers is a description that has to name it, not a block to put back.
