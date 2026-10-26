# Brain

Your coding agents start every session knowing nothing about you, and each tool you use forgets separately.
Pi does not know what Codex was told. A long session drops the oldest context. A new chat starts cold.

Brain is one durable store of your notes and your rules, served over MCP, that every host reads and
writes. Tell pi your garage code once, and the next session, the next model, and a different editor on the
other machine all get it.

```
pi / Codex / Cursor / Claude Code  ──MCP──▶  one Worker  ──▶  one Durable Object
                                                              SQLite: notes + rules
```

No model runs here. Your agent does the thinking, Brain stores and searches it, and answers in about 4 ms.

## What it does for you

- Say it once, and every agent knows it in every new chat.
- Nothing is stored, changed, or deleted without you asking.
- Your Cloudflare account, on free tier. No API key, no bill.

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

A week of it looks like this:

```
you (in pi):    garage code?
  → brain_recall  query:"garage code"     ← notes · #1 · Garage door code is 4417 #home #code

you (in Codex): stop opening replies with "Sure!"
  → brain_learn   text:"Never open a reply with 'Sure!'"  tags:"replies"

you (next week, different model): write me a test for the parser
  → brain_recall  returns the testing rules beside the notes, with the authority paragraph under them
```

Style rules about how every reply reads are the one kind a task query cannot find, because nothing in
"what's the garage code" points at "no em dashes". Keep those in a global `AGENTS.md` on the hosts that read
one, and let Brain hold everything that a task can name.

## Connect a host

Brain is a regular MCP server at `https://<worker>.workers.dev/mcp`. Point any host at that URL.

Cloudflare Access is the whole access control. Protect the Worker in **Workers & Pages → your Worker →
Access**, pick who signs in, then turn on **Managed OAuth** in that app's advanced settings. The free plan
covers 50 users. Access answers an unauthenticated request before any tool runs, so a host that speaks MCP
authorization signs in in the browser and renews on its own afterwards. To cut someone off, drop them from the
policy — no redeploy, nothing to rotate.

## Tools

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

## Caps

`MAX_NOTE` (300) caps one note; a write over the cap throws and names the overage, and nothing truncates.
`learn` caps a rule at `MAX_RULE` characters and refuses one carrying a link, an email or a code fence,
because a rule should state behaviour and not point somewhere else. Notes and rules are otherwise uncapped:
both cost tokens only on the turns that retrieve them.

`BRAIN_HOSTNAME` must name the hostname you serve, and the `workers.dev` URL counts as one. The host check
only allows `localhost` without it, so a deploy that skips this answers every `tools/list` with 403
`Invalid Host`. Set it before the first deploy, not after.

## Run it

`wrangler.jsonc` carries an `access.dev` block as the local stand-in for a signed-in identity: change the
email to test as someone else, delete the block to test the refusal. Put `BRAIN_HOSTNAME` and `MAX_NOTE` in
`.dev.vars`, then:

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Local rows live in `.wrangler/state`, so a deploy starts empty.

```sh
npm run check
npx wrangler deploy --dry-run
npx wrangler deploy
```
