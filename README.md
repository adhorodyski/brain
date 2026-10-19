# durable-personal-agent

One assistant brain on my Cloudflare account. It remembers what I tell it, keeps time for me, and reads
links I forward. Two doors, same conversation: **Telegram** on the phone, and **`pi` in my terminal** over
MCP. No app, no dashboard, no tab to open.

It is not a digital employee. It never sends email, books anything, or acts in my accounts. It reads the
web when asked, writes notes, and speaks on schedule. That boundary is deliberate, and it is the reason
the tool list is as short as it is.

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
| **forget** | Wipes every note and plan. Refuses to run without `confirm: "ERASE"`, and isn't offered to the read-only mount. |
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

### 2. Collect the five secrets

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

Then, in another terminal — substituting the `BRAIN_TOKEN` value you just put in `.dev.vars`:

```sh
curl -s localhost:8787/health

curl -s localhost:8787/mcp -X POST \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer <BRAIN_TOKEN from .dev.vars>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expected: `/health` answers `{"brain":"adam"}`, the MCP call lists all six tools, and dropping the header
gives **401**. Notes written here go to local simulated storage only; deploying starts an empty brain.

### 4. Secrets, then deploy

```sh
npx wrangler login

npx wrangler secret put CALLSTACK_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put BRAIN_TOKEN

npx wrangler secret list          # confirm all five are there
npx wrangler deploy
```

Each `secret put` prompts for the value and, as a side effect, publishes a new Worker version — which is why
they go **before** `deploy`, so the first version that serves traffic is already configured. **Set them once:
secrets live on the Worker, not on a version, and every later `wrangler deploy` keeps them.** Set the
optional `BRAIN_READ_ONLY_TOKEN` the same way if you want the read-only mount.

The first deploy needs `migrations: [{ tag: "v1", new_sqlite_classes: ["Assistant"] }]`, already in
[`wrangler.jsonc`](wrangler.jsonc) — without it the Worker deploys and then fails at runtime with *"no such
Durable Object class"*. Never edit an old migration tag; add a new one.

### 5. Prove it's live

```sh
curl -s https://<your-worker>.workers.dev/health    # {"brain":"adam"}
npx wrangler tail                                   # leave this open while you test
```

`wrangler tail` is the only window into the brain — every model failure and rejected webhook shows there
and nowhere else. Note the Worker may need a minute to be reachable on `workers.dev` the first time.

### 6. Wire up Telegram

```sh
./scripts/set-webhook.sh
```

It sets the webhook URL and the shared secret in one call. Send your bot a message:

> remember that the garage code is 4417

The reply is sent **once**, never edited — no fake streaming, no edit-as-typewriter walking into Telegram's
flood control.

### 7. Wire up your terminal

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

Seven small modules and one type declaration, ~560 lines. Everything else is reused: Pi Durable for the
agent loop, `PiHarness` to host it in a Durable Object, the Agents SDK's MCP handler, Telegram's Bot API
over plain `fetch`.

| File | |
|---|---|
| `src/index.ts` | Two routes and both guards |
| `src/assistant.ts` | The brain: `PiHarness`, turns, plans |
| `src/tools.ts` | The four tools the brain sees, and `defang` |
| `src/store.ts` | Notes and plans in SQLite — shared by both doors |
| `src/door.ts` | MCP mount and the bearer-token choice |
| `src/telegram.ts` | Send, with Telegram's 4096-char split |
| `src/model.ts` | Apex, direct |

Writes from the terminal are **direct SQLite**, not a turn through the brain: storing a note costs ~80
tokens and grows nobody's transcript. `ask` is the metered one.

The `forget` tool (trusted mount only) wipes every note and plan — it refuses to run unless you pass
`confirm: "ERASE"`, and it isn't offered to the read-only mount.

## Day two

```sh
npx wrangler deploy            # every code change; the DO restarts, its SQLite does not
npx wrangler tail              # live errors
npx wrangler deployments list  # and rollback in the dashboard if a deploy is bad
```

A deploy restarts every running Durable Object but keeps its storage, so notes and schedules survive and an
in-flight turn simply resumes. To wipe the brain's memory, use the `forget` tool above, or delete the
object's data at *Workers → Durable Objects → Assistant → adam*.

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

Not built here on purpose, and please don't add them back without a reason: any UI, ChatStorage,
Cloudflare Access, bash or any code execution, multi-user scopes, subagents, voice, photo ingestion. Every
one was considered and cut; the reasoning lives in my local `pi-assistant-plan/PLAN.md`, not in this repo.
