# durable-personal-agent

A durable archive of one person's facts and standing instructions, on Cloudflare, reached over MCP by
whatever agent they happen to be using. **The brain runs no inference on the request path.** Hosts do the
thinking; this answers in milliseconds and persists.

```
pi / Codex / Cursor / Claude Code  ──MCP──▶  one Worker ──▶  one Durable Object
                                                            SQLite: notes + instructions
```

Two tables, seven tools, one endpoint, two runtime dependencies. The design and every measured decision
behind it are in [MEMORY-DESIGN.md](MEMORY-DESIGN.md), which is the source of truth for this repo.

## What it holds

| | |
|---|---|
| `notes` | Facts. Anything that can be true or false: codes, addresses, decisions, dates, who people are. Uncapped, FTS5-searched, two tiers — `note` is free and reachable only by search, `core` is a small budgeted set that prints its fill on every write. |
| `instructions` | Rules. Anything that can only be obeyed: British English, edit in place, no "great question". Budgeted, retired by newer rules on the same topic, and rendered into **every** tool response. |

The test a host applies, and the one to apply when reading a stored row: can the sentence be **false**? Then
it is a note. Can it only be **obeyed**? Then it is an instruction.

| Tool | |
|---|---|
| `brain_recall` | Ranked lines from FTS5, plus a `## Related` block of tag neighbours when the query points at one subject. |
| `brain_remember` | Stores facts in batches. Refuses an over-long note or a `core` write that would overflow the budget, naming the overage. |
| `brain_patch` | Rewrites one note. Needs the id **and** words from that note's own text, because rowids get reused. |
| `brain_forget` | Deletes one note behind the same agreement. `destructiveHint`. |
| `brain_learn` | Stores one rule. Refuses anything over 200 characters, and any rule carrying a link, an email or a code fence. |
| `brain_unlearn` | Retires one rule. Retired rules leave `recall` and stay in `export`. |
| `brain_export` | The whole brain as JSON, retired rows included, in `content` and in `structuredContent`. |

Every response ends with the standing-instruction block, so a host is told the owner's rules on every call and
compaction cannot lose them. Writes carry a dedupe key hashed from the arguments plus the owner, so a transport
retry stores one row and reports `again, same call` rather than paying twice. Owner and source come from the
token and are never tool arguments, so a page cannot name a thing that isn't accepted as input.

## Setup

Node 22+ and a Cloudflare account on the free tier. No model, no provider account, no API key — the brain
calls nothing.

### 1. Install

```sh
npm install
npm run check
npx wrangler deploy --dry-run
```

The bundle is about 1247 KiB raw / 218 KiB gzipped. A jump of tens of KiB means something pulled in a
dependency it should not have.

### 2. Make a token per person

```sh
openssl rand -hex 32
```

One token per person is what makes provenance mean anything and is what lets two people share one brain: a
shared token makes every note read as written by both, and leaves the ownership guard with nothing to compare.

### 3. Run it locally

```sh
cp .dev.vars.example .dev.vars     # put your generated tokens in as token=owner pairs
npm run dev
```

In another terminal:

```sh
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/health

curl -s localhost:8787/mcp -X POST \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer <your token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expect `200`, then all seven `brain_` tools. Removing the header must answer 401 **with** a
`WWW-Authenticate` challenge — a host that gets a 500 reads the brain as an outage rather than asking for a
token.

Local notes live in `.wrangler/state`, so a deploy still starts empty.

### 4. Deploy

```sh
npx wrangler login
npx wrangler secret put BRAIN_TOKENS
npx wrangler deploy
```

`BRAIN_TOKENS` is the comma-separated `token=owner` list from `.dev.vars.example`. An unknown or missing token
gets 401 before any tool runs, and there is no default owner.

The first deploy needs `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Brain"] }]`, which is already in
`wrangler.jsonc`. Without it the worker deploys cleanly and then fails at runtime with "no such Durable Object
class". Tags are append-only: add a new one, never edit an old one.

### 5. Add it to a host

```sh
pi mcp add brain --url https://<your-worker>.workers.dev/mcp --bearer-token-env-var BRAIN_TOKEN
```

Pi reads the server's `instructions` string into connection state, so the trigger line really is delivered. It
skips OAuth entirely because an `Authorization` header is present, and it accepts a `405` on the server-to-client
stream and carries on. Codex, Cursor, Claude Code and claude.ai all take a static bearer over streamable HTTP, so
the same endpoint serves them unchanged.

### Optional vars

| Var | Default | |
|---|---|---|
| `CORE_TOKENS` | `900` | Budget for `core` notes, printed as a char count and a percentage on every write. |
| `MAX_NOTE` | `300` | Longest allowed note, in characters. |
| `INSTRUCT_TOKENS` | `300` | Budget for active instructions. Separate from `CORE_TOKENS`, so a chatty week of facts cannot evict the tone rules. |
| `TIMEZONE` | `UTC` | Rendered into the standing-instruction header so relative dates are unambiguous. |
| `BRAIN_HOSTNAME` | unset | Set once you serve a custom hostname. `localhost` and `workers.dev` are accepted without it. |

## Verification

v0 ships no automated tests on purpose: the whole surface is one MCP endpoint over DO SQLite, and every
behaviour is answerable in seconds with `curl` or a `pi` client. The [spec's Verification
table](MEMORY-DESIGN.md) is the checklist, and it is what was run by hand before shipping. The rows worth
re-running after any change:

| Check | Expect |
|---|---|
| `POST /mcp` with no header | 401 with `WWW-Authenticate`, before any tool runs |
| `tools/list` with a valid token | all seven `brain_` tools |
| The same `remember` twice | one row, the second call reports `again, same call` |
| Two tokens sending different text | both rows stored, in **one** brain |
| `recall` for a stray quote, bare punctuation, an empty query | `nothing stored matching …`, never an `fts5: syntax error` |
| `patch`, then `recall` for the old wording | no match, and `count(*)` still equal between `notes` and `notes_ft` |
| `patch` where `confirm` is absent from that row | nothing changes, the refusal says why |
| `forget` on a row whose owner differs | nothing changes, the refusal names the owner |
| `learn` superseding a rule | the loser is `active = 0`, gone from `recall`, present in `export` |

Then the behavioural probe, which is the only check that catches a preference silently not sticking: six
utterances through a cheap host model — *"always use British English"*, *"you were too verbose, stop that"*,
*"I prefer bullets over prose"*, *"next time edit rather than rewrite"*, *"my garage code is 4417"* which must
hit `brain_remember`, and *"what's my garage code"* which must write nothing.

## Notes for whoever edits this next

Read [MEMORY-DESIGN.md](MEMORY-DESIGN.md) first. It records the four runtime gotchas that cost hours and throw
nothing at build time — `DurableObject` is not a global, a verifier must throw `OAuthError` rather than `Error`,
`requireBearerAuth` refuses a token with no `expiresAt`, and `ctx.mcpReq.id` restarts at 1 per client session so
it can never be a dedupe key. It also records why the schema is held as an array of statements: the sync triggers
contain semicolons, so splitting the DDL on `;` silently destroys them and `recall` returns nothing forever.

Storage is Durable Object SQLite rather than D1 because DO SQLite has no daily rows-read cap and an FTS5 search
reads rows. Its single-threaded execution is what makes the budget check and the supersede step un-raceable.

Everything in the spec's Non-goals stays out: no reminders, no curation pass, no web fetch, no `ask`, no
Telegram, no vectors, no OAuth, no UI.
