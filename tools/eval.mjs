import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startDevServer } from "./dev-server.mjs";

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};

const PORT = Number(process.env.EVAL_PORT ?? 8901);
const RUN_TIMEOUT_MS = 180_000;
const HERE = new URL(".", import.meta.url);
const repo = new URL("..", HERE).pathname;

const name = flag("class", undefined);
const runs = Number(flag("runs", 12));
const model = flag("model", undefined);

if (!name) {
  console.error("usage: node tools/eval.mjs --class <name> [--runs N] [--model provider/model]");
  console.error(`classes: ${readdirSync(new URL("prompts", HERE)).map((file) => file.replace(".md", "")).join(", ")}`);
  process.exit(1);
}

const prompts = readFileSync(new URL(`prompts/${name}.md`, HERE), "utf8")
  .split("\n")
  .map((line) => line.trim().replace(/^[-*]\s+/, ""))
  .filter((line) => line && !line.startsWith("#"))
  .slice(0, runs);

async function seedBrain(seed) {
  const client = new Client({ name: "eval", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  await client.callTool({ name: "brain_remember", arguments: { items: seed.notes } });
  for (const rule of seed.rules) await client.callTool({ name: "brain_learn", arguments: rule });
  await client.close();
}

function runPi(scratchDir, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["-a", "-p", "--no-session", "--mode", "json", ...(model ? ["--model", model] : [])], { cwd: scratchDir });
    let transcript = "";
    const record = (chunk) => (transcript += chunk);
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi timed out after ${RUN_TIMEOUT_MS / 1000}s`));
    }, RUN_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(transcript);
    });
    child.stdin.end(prompt);
  });
}

function events(transcript) {
  return transcript
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function brainCallsIn(transcript) {
  return events(transcript).reduce((count, event) => {
    if (event.type !== "tool_execution_start") return count;
    if (event.toolName === "codemode") return count + (JSON.stringify(event.args).match(/brain_(recall|remember|patch|forget|learn|unlearn|export)\b/g) ?? []).length;
    return event.toolName?.includes("brain") ? count + 1 : count;
  }, 0);
}

function harnessFailure(transcript) {
  if (transcript.includes("No API key found")) return "pi has no provider credentials";
  if (transcript.includes("is ignored because the project is not trusted")) return "the project .pi/mcp.json is not trusted";
  for (const event of events(transcript)) {
    if (event.message?.stopReason === "error" || event.message?.stopReason === "aborted") return `pi stopped with ${event.message.stopReason}`;
    if (event.type === "agent_settled" && event.aborted) return "pi aborted the run";
  }
  return undefined;
}

const seed = JSON.parse(readFileSync(new URL(`seeds/${name}.json`, HERE), "utf8"));
const results = join(repo, "tools", "results", `${new Date().toISOString().slice(0, 10)}-${name}`);
mkdirSync(results, { recursive: true });

let unprompted = 0;
for (const [index, prompt] of prompts.entries()) {
  const stateDir = mkdtempSync(join(tmpdir(), "brain-eval-state-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "brain-eval-scratch-"));
  mkdirSync(join(scratchDir, ".pi"), { recursive: true });
  writeFileSync(join(scratchDir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { brain: { url: `http://127.0.0.1:${PORT}/mcp` } } }));
  writeFileSync(join(scratchDir, "dedupe.ts"), "export function dedupe(items: unknown[]) {\n  return items.filter((item, at) => items.indexOf(item) === at);\n}\n");

  const { child, ready } = startDevServer(PORT, stateDir);
  try {
    await ready;
    await seedBrain(seed);
    const transcript = await runPi(scratchDir, prompt);
    const failure = harnessFailure(transcript);
    if (failure) throw new Error(`run ${index + 1} failed as harness, not as a zero: ${failure}`);
    const calls = brainCallsIn(transcript);
    unprompted += calls > 0 ? 1 : 0;
    writeFileSync(join(results, `run-${index + 1}.jsonl`), transcript);
    console.log(`run ${index + 1} of ${prompts.length}: ${calls} brain calls`);
  } finally {
    child.kill("SIGTERM");
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

writeFileSync(join(results, "summary.json"), JSON.stringify({ class: name, model: model ?? "pi default", calls: `${unprompted} of ${prompts.length}`, prompts }, null, 2) + "\n");
console.log(`\n${unprompted} of ${prompts.length} runs called a brain tool unprompted`);
console.log(`transcripts: tools/results/${results.split("/").at(-1)}/`);
