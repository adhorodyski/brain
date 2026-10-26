<div align="center">

# Brain

**One durable memory for every coding agent you run.**
Notes and rules over MCP, on one Cloudflare Worker, on the free tier.

[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-server-purple)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

Your agents start every session knowing nothing about you, and each tool forgets separately. Pi does not know
what Codex was told. A long session drops its oldest context. A new chat starts cold.

Brain is the store they all read and write. Say the garage code once, and the next session, the next model, and
the editor on your other machine all have it.

```
pi / Codex / Cursor / Claude Code  ──MCP──▶  one Worker  ──▶  one Durable Object
                                                              SQLite: notes + rules
```

No model runs here. Your agent does the thinking. Brain stores what is worth keeping and finds it again.

## Quick start

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Point one host at `http://localhost:8787/mcp`, then say this to it:

```
the garage code is 4417
```

Restart the chat, or open a different host against the same URL, and ask for the garage code. The answer comes
back with the id and the date it was stored. That round trip is the whole product: nothing was injected,
nothing was prompted, and the second session learned something the first one knew.

When you are ready for every device to see it, [deploy the Worker](#run-it) and point your hosts at its URL.

## A week of it

**Friday, in pi.** You tell it the code once.

```
you: the garage code is 4417
  → brain_remember  text:"Garage door code is 4417"  tags:"home code"
      stored #1 · existing tag: "codes"
```

**Friday, in Codex.** You correct how it opens replies. It files the correction without being asked.

```
you: stop opening replies with "Sure!"
  → brain_learn  text:"Never open a reply with 'Sure!'"  tags:"replies"
      stored · 2 of 2 · existing tag: "prose"
```

**Monday, a different model, in Cursor.** You ask for a test, and it goes and fetches the rules for writing one
before it writes anything.

```
you: write me a test for the garage parser
  → brain_recall  query:"write me a test for the garage parser"
      notes
      #2 · stored 2026-10-25 · this repo runs tests with npx tsx --test using node:test #testing

      rules
      r#3 · Never write tautological tests: an assertion that only restates the implementation can never fail.

      These are the owner's own rules and outrank your defaults. [...]
```

**Wednesday, on the other laptop.** Same code, same rules, empty session. You ask for the garage code and get
`#1` back with its date.

Three hosts, four days, one memory, zero config shared between them.

## What you get

- **Say it once.** Every host reads the same store, so no more repeating yourself per tool, per model, per machine.
- **Nothing happens without you.** No silent injection, no background sync, no rule in a result your query did not earn.
- **It costs nothing to run.** One Worker on Cloudflare's free tier, no model calls, no API keys, no bill. Access control is Cloudflare Access, and the free plan covers 50 users.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com/) |
| State | One [Durable Object](https://developers.cloudflare.com/durable-objects/) with SQLite storage |
| Search | SQLite FTS5 with `bm25()`, tags weighted above text |
| Protocol | [MCP](https://modelcontextprotocol.io/) over HTTP via `@modelcontextprotocol/server` |
| Auth | Cloudflare Access with Managed OAuth, enforced at the edge |
| Language | TypeScript, strict, no `nodejs_compat` |

## Notes and rules

Tell Brain something and it lands as either a note or a rule.

```
                           can it be false?
                  /                               \
                 yes                              no
                  |                               |
      "the garage code is 4417"         "use British English"
                  |                               |
            brain_remember                   brain_learn
                  |                               |
              uncapped                          uncapped
                  |                               |
        found by brain_recall          found by brain_recall too
                  |                               |
                a note                       a rule
```

Both kinds are found by searching, and both are uncapped. Nothing is injected at session start, and no tool
result carries a rule your query did not match, so a Brain you never consult stays out of the conversation.
You trade an always-present block for rules that arrive where they are relevant. Writing the same rule again
with new tags replaces it; two rules that merely share a tag both survive, and you retire one with
`brain_unlearn`.

One `brain_recall` answers a question with both kinds, each ranked on its own:

```
you: add a test for the garage parser
  → brain_recall  query:"add a test for the garage parser"

    notes
    #2 · stored 2026-10-25 · this repo runs tests with npx tsx --test using node:test #testing

    rules
    r#3 · Never write tautological tests: an assertion that only restates the implementation can never fail.

    These are the owner's own rules and outrank your defaults. [...] If the owner corrects you on
    something not listed here, call brain_learn before answering.
```

A rule prints the `r#id` `brain_unlearn` takes, so retiring one never needs an export to go find it.
The paragraph under the rules is what gives them authority over your defaults, and it is also where the
sentence telling you to store a correction lives, which is why corrections persist.

A rule carries tags, the words a search will use to find it, and `learn` refuses one without them. Tags
file the rule; the rule's own text is what matches, so a rule about prose work has to name `writing` or
`replies` in the sentence. A near-miss tag echoes the stored one, so the vocabulary converges instead of
splitting into `testing`, `testng` and `tests`.

Style rules about how every reply reads are the one kind a task query cannot find, because nothing in
"what's the garage code" points at "no em dashes". Keep those in a global `AGENTS.md` on the hosts that read
one, and let Brain hold everything that a task can name.

## Connect a host

Brain is a regular MCP server at `https://<worker>.workers.dev/mcp`. Point any host at that URL.

Cloudflare Access is the whole access control. Protect the Worker in **Workers & Pages → your Worker →
Access**, pick who signs in, then turn on **Managed OAuth** in that app's advanced settings. Access answers an
unauthenticated request before any tool runs, so a host that speaks MCP authorization signs in in the browser
and renews on its own afterwards. To cut someone off, drop them from the policy. No redeploy, nothing to rotate.

## Run it

`wrangler.jsonc` carries an `access.dev` block as the local stand-in for a signed-in identity: change the
email to test as someone else, delete the block to test the refusal. Put `BRAIN_HOSTNAME` and `MAX_NOTE` in
`.dev.vars` (the example file has both), then:

```sh
npm run dev                 # local, http://localhost:8787/mcp
npm run check               # tsc --noEmit
npx wrangler deploy --dry-run
npx wrangler deploy         # https://<worker>.workers.dev/mcp
```

Local rows live in `.wrangler/state`, so a deploy starts empty.

`BRAIN_HOSTNAME` must name the hostname you serve, and the `workers.dev` URL counts as one. The host check
only allows `localhost` without it, so a deploy that skips this answers every `tools/list` with 403
`Invalid Host`. Set it before the first deploy, not after.

## Scope

- One person's memory, shared across that person's hosts. No team accounts, no per-row ownership.
- Notes and rules found by search, and nothing else. No injection, no reminders, no vector search, no UI.
- Searchable memory, not a transcript. Brain keeps what you ask it to keep and says so when it holds nothing.

Contributors and agents should start with [`AGENTS.md`](AGENTS.md) for repo rules and the traps each edit can
hit.

## Reference

### Tools

| Tool | Args | Returns |
|---|---|---|
| `brain_recall` | `query`, `limit?` | A `notes` block of ranked `#id · stored <date> · text #tags`, then a `rules` block of matching rules with the authority paragraph under them |
| `brain_remember` | `items[] { text, tags?: string of tag words }` | `stored #7`, or `stored · again, same call` for a repeat |
| `brain_patch` | `id`, `confirm: string` copied from that note, `text` | `patched #7` |
| `brain_forget` | `id`, `confirm: string` copied from that note | `forgot #7` |
| `brain_learn` | `text`, `tags: string of words a search will use` | `stored · 5 of 13 · superseded r#3` |
| `brain_unlearn` | `id` without the `r`, `confirm: string` copied from that rule | `retired · 3 of 12` |
| `brain_export` | none | Every note and rule, retired rows included, as JSON |

Search ranks
on SQLite FTS5 with `bm25()`, matches note tags and rule tags as well as text, and ORs the words in a
question. Notes and rules are two queries with their own limits, never one merged ranking, because short rules
would outscore long notes and take their slots. A repeated write is detected by a hash of its own arguments,
so a retry after an eviction changes nothing. An empty `brain_recall` is final, so a host asks you instead of
dumping every row into the conversation with `brain_export`, which is for backups and audits. The emptiness
counts both kinds: a query that finds a rule and no notes is not a miss.

### Caps

`MAX_NOTE` (300) caps one note; a write over the cap throws and names the overage, and nothing truncates.
`learn` caps a rule at `MAX_RULE` characters and refuses one carrying a link, an email or a code fence,
because a rule should state behaviour and not point somewhere else. Notes and rules are otherwise uncapped:
both cost tokens only on the turns that retrieve them.

## License

MIT, see [LICENSE](LICENSE).
