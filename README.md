# durable-personal-agent

One assistant brain on your Cloudflare account. It remembers what you tell it, keeps time for you, and reads
links you forward. Two doors, one conversation: Telegram on your phone, and `pi` in your terminal over MCP.
No app to install and no dashboard to check.

```
Telegram ─┐ secret + chat-ID allowlist    ┌─ Assistant (one Durable Object)
          ├───────────────────────────────┤   transcript · SQLite notes · alarms
pi (MCP)  ┘ bearer token                  ┘
```

## What you get

| Tool | |
|---|---|
| `remember` | Notes, written once, searchable years later. A retried write lands once, not twice. |
| `recall` | Matching lines straight from SQLite. Costs no model call. |
| `ask` | A reasoned answer drawn from your notes. The only tool that costs an agent turn. |
| `schedule` | One-off and recurring reminders, delivered by a Durable Object alarm with nothing of yours running. Lists and cancels. |
| `fetch_page` | Reads a URL and returns fenced text, so a hostile page cannot speak as you. |
| `forget` | Wipes every note and plan. Requires `confirm: "ERASE"`. |

Both doors write the same thread, so you can ask from the terminal and continue from the phone. The brain
reads, writes notes, and talks on schedule. It holds no credentials in your accounts and cannot run code.

A second optional token, `BRAIN_READ_ONLY_TOKEN`, exposes `recall` and nothing else. That is the mount you
would attach to ChatGPT or Claude through their custom-server endpoints. `ask` cannot be read-only: it runs a
brain turn, and that turn holds write tools.

## Setup

You need Node 22+, a Cloudflare account on the free tier, a Telegram bot, and any OpenAI-compatible chat
endpoint. Your only spend is inference.

### 1. Install

```sh
npm install
npm run check
```

`package.json` pins `@aws-sdk/credential-provider-http` to `3.972.76` because `pi-ai` pulls in the AWS SDK
for Bedrock, and upstream published a `3.972.77` whose tarball returns 404. Without the pin, `npm install`
fails for reasons unrelated to this project. Delete the `overrides` block once that tarball resolves.

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

`/health` returns `{"brain":"brain"}`, the MCP call lists six tools, and removing the header returns 401.
Local notes live in simulated storage, so deploying starts with an empty brain.

### 4. Set your vars and secrets, then deploy

Edit `MODEL_BASE_URL` and `MODEL_ID` in `wrangler.jsonc`. They are plain vars rather than secrets because
neither is sensitive, and a deploy carries them. Locally, `.dev.vars` overrides them, which is the easiest
way to try a second provider without touching committed config.

```sh
npx wrangler login

npx wrangler secret put MODEL_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put BRAIN_TOKEN

npx wrangler secret list
npx wrangler deploy
```

Each `secret put` prompts for a value and publishes a worker version as a side effect, so set them before
`deploy` and the first version serving traffic is already configured. Secrets live on the worker rather than
on a version, so you set them once and later deploys keep them.

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
  "recall": "codemode", "fetch_page": "codemode"
}
```

`description` matters more than it looks, because pi puts MCP server instructions in no tool description.
This string is the only thing a model reads before deciding whether to call the brain at all.

If you run a permission gate in pi, such as `pi-permission-system`, allowlist `brain_*`. Every MCP call goes
through pi's tool pipeline, and a non-interactive run cannot approve one. Until you allowlist them, headless
calls (`pi -p`, `--mode json`, background panes) answer "requires approval, but no interactive UI is
available" every time.

### Optional vars

Put these in `wrangler.jsonc` under `vars`, or in `.dev.vars` while developing.

| Var | Default | |
|---|---|---|
| `MODEL_CONTEXT_WINDOW` | `128000` | Lower it if your endpoint caps below what it advertises. |
| `MODEL_MAX_TOKENS` | `8192` | Completion cap. Over-declaring against a real ceiling fails at request time. |
| `MODEL_REASONING` | unset | Set `true` when the endpoint returns reasoning deltas. |
| `BRAIN_NAME` | `brain` | Also names the Durable Object. Changing it starts an empty brain. |
| `TIMEZONE` | `UTC` | Used for the clock in the brain's prompt and for scheduled times. |
| `BRAIN_HOSTNAME` | unset | Set once you serve a custom hostname, so MCP host validation accepts it. |

## After the first deploy

```sh
npx wrangler deploy            # every code change
npx wrangler tail              # live errors
npx wrangler deployments list  # roll back from the dashboard if a deploy is bad
```

A deploy restarts the Durable Object and keeps its storage, so notes and schedules survive and a turn that
was mid-flight resumes. To clear the brain's memory, call `forget` or delete the object under Workers →
Durable Objects → Assistant → brain.
