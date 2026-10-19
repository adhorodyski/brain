# durable-personal-agent

One assistant brain on my Cloudflare account. It remembers what I tell it, keeps time for me, and reads
links I forward. Two doors, same conversation: **Telegram** on the phone, and **`pi` in my terminal** over
MCP. No app, no dashboard, no tab to open.

It is not a digital employee. It never sends email, books anything, or acts in my accounts. It reads the
web when asked, writes notes, and speaks on schedule. That boundary is deliberate — see
[What it will not do](#what-it-will-not-do).

```
Telegram ──┐  secret + chat-ID allowlist   ┌─ Assistant (one Durable Object, named "adam")
           ├───────────────────────────────┤   Pi Durable transcript · SQLite notes
pi (MCP) ──┘  bearer token → tool mount    ┘   schedules that fire with nothing of mine running
```

## What you get

| | |
|---|---|
| **remember** | Notes, written once and searchable years later. Retried writes land once, not twice. |
| **recall** | Raw matching lines, straight from SQLite. Never costs a model call. |
| **ask** | A real answer, reasoned from the notes. The one tool that costs an agent turn. |
| **schedule** | One-off and recurring, delivered to Telegram from a Durable Object alarm. List and cancel. |
| **fetch_page** | Reads a URL, truncates it, and fences it as data so a hostile page can't speak as me. |
| **Two doors, one thread** | Ask from the terminal, continue from the phone. Same transcript, same memory. |

## Setup

Node 22+, a Cloudflare account (free tier is enough — you spend only on inference), a Telegram bot, and a
Callstack API key.

### 1. Install and check

```sh
npm install
npm run check
```

`package.json` pins `@aws-sdk/credential-provider-http` to `3.972.76`. `pi-ai` pulls the AWS SDK for
Bedrock, and upstream published a `3.972.77` that is listed on the registry but whose tarball returns 404 —
without the pin, `npm install` fails for reasons that have nothing to do with this project. Delete the
`overrides` block once `3.972.77` resolves.

### 2. Collect the four secrets

**Telegram** — message [@BotFather](https://t.me/BotFather): `/newbot`, keep the token it prints. Then
message your new bot once from your phone and open:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Your number under `chat.id` is your chat ID. Nobody else's message will be answered.

**Model** — an `api.callstack.ai` key. If you use a different OpenAI-compatible endpoint, change `baseUrl`,
`MODEL_ID` and `contextWindow` at the top of [`src/model.ts`](src/model.ts).

**Two random strings** — the MCP token and the webhook secret:

```sh
openssl rand -hex 32   # BRAIN_TOKEN
openssl rand -hex 24   # TELEGRAM_WEBHOOK_SECRET
```

### 3. Try it locally

```sh
cp .dev.vars.example .dev.vars   # fill in the values above
npm run dev
```

Then, in another terminal:

```sh
curl -s localhost:8787/health
curl -s localhost:8787/mcp -X POST \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $BRAIN_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`/health` answers, `/mcp` lists five tools with the token and returns **401** without it, and the Telegram
route returns **403** unless the webhook secret matches. Notes written here live in local simulated
storage only; deploying starts a fresh brain.

### 4. Deploy

```sh
npx wrangler login
npx wrangler deploy

npx wrangler secret put CALLSTACK_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put BRAIN_TOKEN
```

Secrets are per-environment, so **run `secret put` again after every deploy that creates a new version you
want to use** — or set them in the Cloudflare dashboard under *Workers → Settings → Variables*.

The first deploy needs `migrations: [{ tag: "v1", new_sqlite_classes: ["Assistant"] }]`, which is already in
[`wrangler.jsonc`](wrangler.jsonc). Never edit an old migration tag — add a new one.

### 5. Wire up Telegram

```sh
./scripts/set-webhook.sh
```

It sets the webhook URL and the shared secret in one call. Send your bot a message:

> remember that the garage code is 4417

The reply is sent **once**, never edited — no fake streaming, no edit-as-typewriter walking into Telegram's
flood control.

### 6. Wire up your terminal

```sh
pi mcp add brain --url https://<your-worker>.workers.dev/mcp --bearer-token-env-var BRAIN_TOKEN
```

That writes to `~/.pi/agent/mcp.json` — **user level, deliberately.** A project's `.pi/mcp.json` is skipped
silently for untrusted folders, and a same-named project entry *replaces* the user one. Add this to the
`brain` entry to skip a discovery round-trip and get the cheap exposure:

```jsonc
"description": "The adam brain — use for anything about adam: his notes, schedule, decisions.",
"toolExposure": {
  "ask": "direct", "remember": "direct", "schedule": "direct",
  "recall": "codemode", "fetch_page": "codemode"
}
```

`description` is load-bearing: pi puts MCP server `instructions` in *no* tool description, so this string is
the only thing a model reads before deciding to call the brain at all.

⚠ **If you use a permission gate in pi** (e.g. `pi-permission-system`): every MCP call runs through pi's
tool pipeline, and non-interactive runs (`pi -p`, `--mode json`, any background pane) answer *"requires
approval, but no interactive UI is available"* forever. **Allowlist `brain_*`** or headless runs get a
polite non-answer every time.

## Two mounts, one brain

`BRAIN_TOKEN` unlocks everything. `BRAIN_READ_ONLY_TOKEN` (optional, unset by default) unlocks **`recall`
only**.

That read-only mount exists for a future I haven't chosen: ChatGPT, Claude and Gemini all accept a custom
MCP URL today, so the day curiosity wins, the worst a stranger's model can do to my notes is read one — not
write a permanent note that sounds like me.

**`ask` is not on that list, and never will be.** It hands the prompt to the brain, and the brain runs with
its full tool registry — `PiSubmitOptions` cannot restrict tools for a single turn. An `ask` answer comes
back from an agent that can write, however much it reads like a question.

## Layout

Six files, ~560 lines. Everything else is reused: Pi Durable for the agent loop, `PiHarness` to host it in
a Durable Object, the Agents SDK's MCP handler, Telegram's Bot API over plain `fetch`.

| File | |
|---|---|
| `src/index.ts` | Two routes and both guards |
| `src/assistant.ts` | The brain: `PiHarness`, turns, plans |
| `src/tools.ts` | The four tools the brain sees |
| `src/store.ts` | Notes and plans in SQLite — shared by both doors |
| `src/door.ts` | MCP mount and the bearer-token choice |
| `src/model.ts` | Apex, direct |

Writes from the terminal are **direct SQLite**, not a turn through the brain: storing a note costs ~80
tokens and grows nobody's transcript. `ask` is the metered one.

Reset the brain without the dashboard: `await brain.forget()` from a callable, or clear the DO's SQLite in
*Workers → Durable Objects*.

## Known rough edges

Honest list, not a bug hunt:

- **`ask` waits 90 s, then gives up politely.** If the brain runs longer, you get "still working" and the
  answer lands in Telegram instead. Recurring `ask` from a script will feel like this.
- **A scheduled reminder that the brain takes longer than 4 minutes to answer arrives as a plain
  `Reminder:` line** instead of its usual reasoned one. The turn still finishes; only the delivery changes.
- **`remember` from the terminal generates a fresh batch key each call,** so retrying the same MCP request
  can store the note twice. The brain's own writes are keyed on the call and don't have this problem.
- **`fetch_page` strips tags with a regex.** Good enough for the pages I forward, not a parser.
- **No images, no voice.** A forwarded photo arrives and is ignored; voice notes arrive as audio and are
  ignored. First real bolt-on when that hurts.
- **`PiHarness` is beta** ("will likely change"). The seam is only in `assistant.ts`, on purpose.

## Credits

Borrowed, not rewritten, because that's cheaper:

- [`xiaomoBoy/pi-durable-edge`](https://github.com/xiaomoBoy/pi-durable-edge) (MIT) — the `PiHarness`
  construction shape and the conservative `compat` flags on the model.
- [`TannerMidd/pi-pocket`](https://github.com/TannerMidd/pi-pocket) (MIT) — `defang` in `tools.ts` (its
  invisible-character evasion handling, verbatim), the `${taskId}:${callId}` dedupe key, and the
  add/list/cancel `schedule` tool shape.
- [`earendil-works/pi-durable`](https://github.com/earendil-works/pi-durable) — the harness itself.

Not built here on purpose: any UI, OpenUI, ChatStorage, Cloudflare Access, bash or code execution,
multi-user scopes, subagents, voice, photo ingestion. Notes in
[`pi-assistant-plan/PLAN.md`](../pi-assistant-plan/PLAN.md) if you're wondering *why not*.
