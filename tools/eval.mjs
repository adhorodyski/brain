import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const args = process.argv.slice(2);
const argAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const CLASS = argAfter("--class", undefined);
const RUNS = Number(argAfter("--runs", 12));
const PORT = Number(process.env.EVAL_PORT ?? 8901);
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
const PI_BIN = process.env.PI_BIN ?? "pi";
const PI_MODEL = argAfter("--model", undefined);
const RUN_TIMEOUT_MS = Number(argAfter("--timeout", 180)) * 1000;
const DEV_BOOT_MS = 90_000;
const HERE = new URL(".", import.meta.url);
const REPO = new URL("..", HERE).pathname;

if (process.versions.bun) {
  console.error("run this with node: wrangler dev cannot forward requests under bun (bun#39247)");
  process.exit(1);
}

function availableClasses() {
  try {
    return readdirSync(new URL("prompts", HERE))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

if (!CLASS) {
  console.error("usage: node tools/eval.mjs --class <name> [--runs N] [--model provider/model]");
  console.error(`classes found: ${availableClasses().join(", ") || "none"}`);
  process.exit(1);
}

const wranglerCli = new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url);

function startDevServer(stateDir) {
  const child = spawn(process.execPath, [wranglerCli.pathname, "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", stateDir, "--log-level", "none"], {
    cwd: REPO,
    stdio: "ignore",
  });
  child.on("error", (error) => {
    console.error(`wrangler failed to start: ${error.message}`);
    process.exit(1);
  });
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  const deadline = Date.now() + DEV_BOOT_MS;
  while (Date.now() < deadline) {
    try {
      const reply = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (reply.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`the dev server never answered /health within ${DEV_BOOT_MS / 1000}s`);
}

async function connect() {
  const client = new Client({ name: "eval", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
  return client;
}

async function loadSeed(client, seed) {
  if (seed.notes?.length) await client.callTool({ name: "brain_remember", arguments: { items: seed.notes } });
  for (const rule of seed.rules ?? []) await client.callTool({ name: "brain_learn", arguments: rule });
}

function runPi(scratchDir, prompt) {
  return new Promise((resolve, reject) => {
    const cli = ["-a", "-p", "--no-session", "--mode", "json"];
    if (PI_MODEL) cli.splice(2, 0, "--model", PI_MODEL);
    const child = spawn(PI_BIN, cli, { cwd: scratchDir });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi timed out after ${RUN_TIMEOUT_MS / 1000}s`));
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`pi failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

function brainCallCount(jsonl) {
  let calls = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "tool_execution_start") continue;
    if (event.toolName === "codemode") {
      const source = JSON.stringify(event.args ?? "");
      calls += (source.match(/mcp__brain__brain_\w+|brain_(recall|remember|patch|forget|learn|unlearn|export)\b/g) ?? []).length;
    } else if (event.toolName?.includes("brain")) {
      calls += 1;
    }
  }
  return calls;
}

function harnessFailure(stdout, stderr) {
  const noise = stdout + stderr;
  if (noise.includes("No API key found")) return "pi has no provider credentials";
  if (/is ignored because the project is not trusted/.test(noise)) return "the project .pi/mcp.json is not trusted";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event.type === "message_end" ? event.message : undefined;
    if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))
      return `pi ended with stopReason ${message.stopReason}: ${JSON.stringify(message.errorMessage ?? message.error ?? "")}`;
    if (event.type === "agent_settled" && event.aborted === true) return "pi aborted the run";
  }
  return undefined;
}

async function main() {
  const prompts = readFileSync(new URL(`prompts/${CLASS}.md`, HERE), "utf8")
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line && !line.startsWith("#"));
  const seed = JSON.parse(readFileSync(new URL(`seeds/${CLASS}.json`, HERE), "utf8"));

  const stamp = new Date().toISOString().slice(0, 10);
  const resultDir = join(REPO, "tools", "results", `${stamp}-${CLASS}`);
  mkdirSync(resultDir, { recursive: true });

  const runs = prompts.slice(0, RUNS);
  let called = 0;
  const rows = [];

  for (const [index, prompt] of runs.entries()) {
    const stateDir = mkdtempSync(join(tmpdir(), "brain-eval-state-"));
    const scratchDir = mkdtempSync(join(tmpdir(), "brain-eval-scratch-"));
    mkdirSync(join(scratchDir, ".pi"), { recursive: true });
    writeFileSync(join(scratchDir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { brain: { url: MCP_URL } } }, null, 2));
    writeFileSync(join(scratchDir, "dedupe.ts"), "export function dedupe(items: unknown[]) {\n  return items.filter((item, at) => items.indexOf(item) === at);\n}\n");

    const server = startDevServer(stateDir);
    try {
      await waitForHealth();
      const client = await connect();
      await loadSeed(client, seed);
      await client.close();

      const { stdout, stderr } = await runPi(scratchDir, prompt);
      const failure = harnessFailure(stdout, stderr);
      if (failure) {
        writeFileSync(join(resultDir, `run-${index + 1}-FAILED.jsonl`), stdout);
        throw new Error(`run ${index + 1} failed as harness, not as a zero: ${failure}`);
      }
      const calls = brainCallCount(stdout);
      if (calls > 0) called += 1;
      rows.push({ prompt, calls });
      writeFileSync(join(resultDir, `run-${index + 1}.jsonl`), stdout);
      console.log(`run ${index + 1} of ${runs.length}: ${calls} brain calls`);
    } finally {
      server.kill("SIGTERM");
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  const summary = { date: stamp, class: CLASS, model: PI_MODEL ?? "pi default", calls: `${called} of ${rows.length}`, runs: rows };
  writeFileSync(join(resultDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`\n${called} of ${rows.length} runs called a brain tool unprompted`);
  console.log(`transcripts: tools/results/${stamp}-${CLASS}/`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`eval failed: ${error.message}`);
  process.exit(1);
});
