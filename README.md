# durable-personal-agent

One person's facts and standing instructions, on Cloudflare over MCP. No model runs here: your agent thinks,
this stores and searches.

## Connect a host

```sh
pi mcp add brain --url https://<worker>.workers.dev/mcp --bearer-token-env-var BRAIN_TOKEN
```

`BRAIN_TOKEN` holds one token and the token names the owner. Tokens are the `BRAIN_TOKENS` secret: a
comma-separated `token=owner` list, one `openssl rand -hex 32` per person.

```sh
npx wrangler secret put BRAIN_TOKENS
```

An unknown or missing token gets 401 with a `WWW-Authenticate` challenge before any tool runs, and an empty
`BRAIN_TOKENS` refuses everything: there is no default owner. Codex, Cursor and Claude Code take it too.

## Tools

Every result, refusals included, ends with the owner's standing-instruction block.

| Tool | Args | Returns |
|---|---|---|
| `brain_recall` | `query`, `limit?` | Ranked `#id · [tier] · stored <date> · text #tags` lines, plus a `## Related` block of tag neighbours |
| `brain_remember` | `items[] { text, tags?, tier? }` | `stored #7 · core 612/3150 (19%)`, or `stored · again, same call` for a repeat |
| `brain_patch` | `id`, `confirm`, `text` | `patched #7` |
| `brain_forget` | `id`, `confirm` | `forgot #7` |
| `brain_learn` | `text`, `scope?` as `always`, `briefing`, `coding`, `writing` | `stored · 5 of 13 · 299/1050 (28%)` |
| `brain_unlearn` | `id`, `confirm` | `retired · 3 of 12 · 193/1050 (18%)` |
| `brain_export` | — | Every note and instruction, retired rows included, as JSON |

A fact (it can be false) goes to `remember`; a rule (it can only be obeyed) goes to `learn`. `tier` is `note`
(free, searchable) or `core` (a small budgeted set). `patch`, `forget` and `unlearn` need the id **and** a
fragment of that row's own text, because a delete frees its rowid and an id alone names nothing.

## Budgets and refusals

`CORE_TOKENS` (900) caps `core` notes and `INSTRUCT_TOKENS` (300) caps active instructions, and neither touches
the other. Budgets count tokens but print characters at `tokens × 3.5`, so a write reports `used/cap (percent)`:
`core 612/3150 (19%)`. An over-budget write throws and stores nothing — nothing is truncated, nothing is
retired to make room — naming the overage: *"this note needs 214, which is 61 over"*. `MAX_NOTE` (300) caps one
note, and `learn` caps a rule at 200 characters and refuses one carrying a link, an email or a code fence.

## Owner

`owner` comes from the token, never from a tool argument, so a page an agent reads cannot forge it. One brain
holds every owner's rows, and `patch`, `forget` and `unlearn` refuse a row owned by someone else, naming that
owner. `TIMEZONE` (UTC) prints in the block header so "next Tuesday" is unambiguous, and `BRAIN_HOSTNAME` is set
only for a custom hostname — `localhost` and `workers.dev` pass without it.

## Running it, and the checks

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
curl -s localhost:8787/health
npm run check
npx wrangler deploy --dry-run
npx wrangler deploy
```

Put the `token=owner` pairs in `.dev.vars`. Local rows live in `.wrangler/state`, so a deploy starts empty. A
bundle tens of KiB past ~218 KiB gzipped means a dependency crept in, and everything else is verified by hand
against `wrangler dev` from the table in [MEMORY-DESIGN.md](MEMORY-DESIGN.md).
