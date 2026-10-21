# durable-personal-agent

One assistant brain on your Cloudflare account. It remembers what you tell it and keeps time for you. One
conversation, several doors: Telegram on your phone, and `pi` in your terminal over MCP. No app to install
and no dashboard to check.

```
┌───────────────────────────────────────────────────┐
│                     Assistant                     │
│       one Durable Object · one conversation       │
└─────────────────────────┬─────────────────────────┘
                          │
            ┌─────────────┴─────────────┐
            │                           │
┌───────────┬───────────┐   ┌───────────┬───────────┐
│       Telegram        │   │          MCP          │
│      your phone       │   │ pi, or any MCP client │
└───────────────────────┘   └───────────────────────┘
```

A door is one guard and one route into that single thread, so adding one changes nothing about the brain.
Telegram checks a webhook secret and a chat ID; MCP checks a bearer token and answers `pi` in the terminal,
or any other client that can post JSON.

## What you get

| Tool | |
|---|---|
| `remember` | Notes, written once, searchable years later. A retried write lands once, not twice. `tier: "core"` holds what must be known without searching. |
| `recall` | Matching lines straight from SQLite, by text or by tag. Costs no model call. |
| `patch` | Changes one note in place, behind the same number-and-words agreement `forget` needs. |
| `ask` | A reasoned answer drawn from your notes. The only tool that costs an agent turn. |
| `schedule` | One-off and recurring reminders, delivered by a Durable Object alarm with nothing of yours running. Lists and cancels. |
| `forget` | Deletes one note, and only the note both its recall number and a quoted word of its text agree on. |
| `web_fetch` | A public URL as text, fenced as data. HTML and documents arrive as Markdown. |

Notes come in two tiers. `core` is a small budget of what the brain must know without searching: who
people are, where things are, standing instructions. It rides in every turn, so it is capped, prints
its own fill percentage, and refuses a write that would not fit. `note` is everything else, uncapped
and reachable only through `recall`. The tier that is always in context gets a price, so the tier
that may grow is the one behind a tool call.

Every door writes the same thread, so you can ask from the terminal and continue from the phone. The brain
reads, writes notes, and talks on schedule. It holds no credentials in your accounts and cannot run code.
That narrow surface is deliberate: `PiHarness` has no approval step for tool calls yet, so the tools above
are the whole permission model. One bearer token unlocks all of them and nothing else, private addresses
are unreachable, and a fetched page is marked as data so a line in it cannot read as an instruction.

## Setup

You need Node 22+, a Cloudflare account on the free tier, a Telegram bot, and any OpenAI-compatible chat
endpoint. Your only spend is inference, plus the odd Workers AI conversion past its free daily allowance.

### 1. Install

```sh
npm install
npm run check
```

### 2. Collect your values

Start with the model. `MODEL_ID` goes on the wire unchanged, so use whatever string your endpoint expects,
and set `MODEL_BASE_URL` to its root, usually ending in `/v1`.

For Telegram, message [@BotFather](https://t.me/BotFather) with `/newbot` and keep the token it returns. Then
message your bot once from your phone and open this, which is also how you find your chat ID:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

The number at `chat.id` is your chat ID. The brain answers that chat and ignores every other one.

Generate two random strings:

```sh
openssl rand -hex 32   # BRAIN_TOKEN
openssl rand -hex 24   # TELEGRAM_WEBHOOK_SECRET
```

### 3. Run it locally

```sh
cp .dev.vars.example .dev.vars   # fill in the values above
npm run dev
```

In another terminal, with your `BRAIN_TOKEN`:

```sh
curl -s localhost:8787/health

curl -s localhost:8787/mcp -X POST \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer <BRAIN_TOKEN from .dev.vars>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`/health` returns `{"brain":"brain"}`, the MCP call answers with every tool the mount offers, and removing the header returns 401.
Local notes live in simulated storage, so deploying starts with an empty brain.

### 4. Set your vars and secrets, then deploy

`MODEL_BASE_URL` and `MODEL_ID`, the two from step 2, live on the worker rather than in this repo, so nothing
here needs editing when you switch provider:

```sh
npx wrangler login

npx wrangler deploy --var MODEL_BASE_URL:https://your-provider.example/v1 --var MODEL_ID:your-model-name
```

`wrangler.jsonc` sets `keep_vars: true`, which is what lets those survive the next `npm run deploy`. Without
it a deploy deletes every var the config does not name, and the brain then refuses every call with
`Set these worker vars: MODEL_BASE_URL, MODEL_ID` while `/health` keeps answering 200. Secrets are never
deleted by a deploy, so these two are the only ones that need the flag.

```sh
npx wrangler secret put MODEL_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put BRAIN_TOKEN

npx wrangler secret list
npx wrangler deploy
```

Each `secret put` prompts for a value and publishes a worker version as a side effect, so set them before
`deploy` and the first version serving traffic is already configured.

`--var` and the dashboard both set these outside the version, so `npx wrangler deployments rollback` restores
code without restoring them. A wrong `MODEL_BASE_URL` fails at request time rather than at once, because the
only check on the value is that it is set.

The first deploy needs `migrations: [{ tag: "v1", new_sqlite_classes: ["Assistant"] }]`, which is already in
`wrangler.jsonc`. Without it the worker deploys cleanly and then fails at runtime with "no such Durable
Object class". Never edit an old migration tag, add a new one.

### 5. Prove it is live

```sh
curl -s https://<your-worker>.workers.dev/health
npx wrangler tail
```

`wrangler tail` is the only place you will see a model error or a rejected webhook, so leave it open while
you test. A new worker can take a minute to answer on `workers.dev`.

### 6. Point Telegram at it

```sh
./scripts/set-webhook.sh
```

Then send your bot this:

> remember that the garage code is 4417

The reply arrives once and never gets edited afterward.

### 7. Add it to pi

```sh
pi mcp add brain --url https://<your-worker>.workers.dev/mcp --bearer-token-env-var BRAIN_TOKEN
```

That writes to `~/.pi/agent/mcp.json`. Keep it there. Pi silently skips a project-level `.pi/mcp.json` in
untrusted folders, and a same-named project entry replaces your user one. Add these keys to the `brain` entry
to skip a discovery round trip:

```jsonc
"description": "The brain. Use it for anything about me: my notes, my schedule, my decisions.",
"toolExposure": {
  "ask": "direct", "remember": "direct", "schedule": "direct",
  "recall": "codemode", "patch": "codemode", "forget": "codemode", "web_fetch": "codemode"
}
```

`description` matters more than it looks, because pi puts MCP server instructions in no tool description.
This string is the only thing a model reads before deciding whether to call the brain at all.

If you run a permission gate in pi, such as `pi-permission-system`, allowlist `brain_*`. Every MCP call goes
through pi's tool pipeline, and a non-interactive run cannot approve one. Until you allowlist them, headless
calls (`pi -p`, `--mode json`, background panes) answer "requires approval, but no interactive UI is
available" every time.

### Optional vars

Set these with `wrangler deploy --var NAME:value` or in the dashboard, and once `keep_vars` is set they need
no `--var` on later deploys. Put them in `.dev.vars` while developing locally.

| Var | Default | |
|---|---|---|
| `MODEL_CONTEXT_WINDOW` | `128000` | Lower it if your endpoint caps below what it advertises. |
| `MODEL_MAX_TOKENS` | `8192` | Completion cap. Over-declaring against a real ceiling fails at request time. |
| `MODEL_REASONING` | unset | Set `true` when the endpoint returns reasoning deltas. |
| `CORE_TOKENS` | `1200` | Budget for the core tier, and so the size of the block sent on every turn. Raising it makes each request heavier. |
| `BRAIN_NAME` | `brain` | Also names the Durable Object. Changing it starts an empty brain. |
| `TIMEZONE` | `UTC` | Used for the clock in the brain's prompt and for scheduled times. |
| `WEB_ALLOWED_HOSTS` | any public host | Comma-separated patterns a fetch may reach. `example.com` is that host alone; `*.example.com` covers subdomains. |
| `WEB_BLOCKED_HOSTS` | unset | Comma-separated patterns a fetch must never reach. Wins over the allowlist. |
| `BRAIN_HOSTNAME` | unset | Set once you serve a custom hostname, so MCP host validation accepts it. |

## After the first deploy

```sh
npx wrangler deploy            # every code change
npx wrangler tail              # live errors
npx wrangler deployments list  # roll back from the dashboard if a deploy is bad
```

A deploy restarts the Durable Object and keeps its storage, so notes and schedules survive and a turn that
was mid-flight resumes. To start the brain empty, delete its data under Workers → Durable Objects →
Assistant → brain, or locally delete `.wrangler/state` while `npm run dev` is stopped.
