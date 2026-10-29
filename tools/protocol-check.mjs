import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const PORT = Number(process.env.PROBE_PORT ?? 8899);
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
const DEV_BOOT_MS = 90_000;
const CALL_TIMEOUT_MS = 30_000;

if (process.versions.bun) {
  console.error("run this with node: wrangler dev cannot forward requests under bun (bun#39247)");
  process.exit(1);
}

const wranglerCli = new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url);

function startDevServer(stateDir) {
  const child = spawn(process.execPath, [wranglerCli.pathname, "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", stateDir, "--log-level", "none"], {
    cwd: new URL("..", import.meta.url).pathname,
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

function withDeadline(promise, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${CALL_TIMEOUT_MS / 1000}s`)), CALL_TIMEOUT_MS);
    }),
  ]);
}

class Probe {
  constructor() {
    this.passed = 0;
    this.failures = [];
  }

  report(name, ok, detail) {
    if (ok) {
      this.passed += 1;
      console.log(`ok   ${name}`);
    } else {
      this.failures.push(name);
      console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
    }
  }

  says(name, actual, expected, detail = `actual: ${JSON.stringify(actual)}`) {
    this.report(name, actual.includes(expected), detail);
  }

  silent(name, actual, fragment) {
    this.report(name, !actual.includes(fragment), `actual: ${JSON.stringify(actual)} mentions ${JSON.stringify(fragment)}`);
  }

  count(name, actual, expected) {
    this.report(name, actual === expected, `actual: ${actual} expected: ${expected}`);
  }

  truthy(name, actual) {
    this.report(name, actual === true, `actual: ${actual}`);
  }
}

async function call(client, name, args) {
  const result = await withDeadline(client.callTool({ name, arguments: args }), name);
  const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
  if (result.isError) throw new Error(`${name} answered as an error: ${text}`);
  return text;
}

async function refused(probe, name, fn) {
  try {
    const text = await fn();
    probe.report(name, false, `no error; the call answered ${JSON.stringify(text)}`);
  } catch {
    probe.report(name, true);
  }
}

async function connect() {
  const client = new Client({ name: "protocol-check", version: "0" }, { capabilities: {} });
  await withDeadline(client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL))), "the MCP handshake");
  return client;
}

async function ranked(client, probe) {
  await call(client, "brain_remember", {
    items: [
      { text: "The garage door code is 4417", tags: "home code" },
      { text: "The meeting room booking for 4417 was cancelled", tags: "work" },
    ],
  });
  const first = await call(client, "brain_recall", { query: "4417" });
  const garageFirst = first.indexOf("garage") >= 0 && first.indexOf("garage") < first.indexOf("meeting");
  probe.report("a query of 4417 ranks the garage note first", garageFirst, `actual: ${JSON.stringify(first)}`);
}

async function syntaxGuard(client, probe) {
  for (const query of ['"', "((x", "\\", '"OR"', "  ", ""]) {
    const text = await call(client, "brain_recall", { query });
    probe.silent(`query ${JSON.stringify(query)} does not raise an fts5 syntax error`, text, "fts5: syntax error");
  }
}

async function tagConvergence(client, probe) {
  await call(client, "brain_remember", { items: [{ text: "The mailbox collection is at noon", tags: "noon" }] });
  const echo = await call(client, "brain_remember", { items: [{ text: "Bin day is Tuesday morning", tags: "novn" }] });
  probe.says("a near-miss tag in notes echoes the stored tag", echo, 'existing tag: "noon"');

  await call(client, "brain_learn", { text: "Never use em dashes in replies to the owner", tags: "dashes" });
  const echoRule = await call(client, "brain_learn", { text: "Keep replies free of decorative punctuation", tags: "dashe" });
  probe.says("a near-miss tag in rules echoes the stored tag", echoRule, 'existing tag: "dashes"');

  const distant = await call(client, "brain_learn", { text: "Commit messages use the imperative mood", tags: "commits" });
  probe.silent("a distant tag echoes nothing", distant, "existing tag");
}

async function dedupe(client, probe) {
  const note = { text: "The wifi password is sunset-lagoon", tags: "home wifi" };
  const first = await call(client, "brain_remember", { items: [note] });
  const again = await call(client, "brain_remember", { items: [note] });
  probe.says("the same write twice reports again, same call", again, "(again, same call)");
  const exported = await structuredExport(client);
  const id = Number(first.match(/#(\d+)/)[1]);
  probe.count("the repeated write stored one row", exported.notes.filter((row) => row.id === id).length, 1);
}

async function structuredExport(client) {
  const result = await withDeadline(client.callTool({ name: "brain_export", arguments: {} }), "brain_export");
  const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
  return typeof payload === "string" ? JSON.parse(payload) : payload;
}

async function supersede(client, probe) {
  const a = { text: "Prefer table-driven tests over one test per case", tags: "coding" };
  const b = { text: "Name the behaviour in the test title", tags: "coding" };
  const c = { text: "Never mock a class the module does not own", tags: "coding" };
  const written = [];
  for (const rule of [a, b, c]) written.push(await call(client, "brain_learn", rule));
  probe.truthy("three rules sharing a tag all store", written.every((line) => line.startsWith("stored")) && !written.some((line) => line.includes("superseded")));

  const found = await call(client, "brain_recall", { query: "coding" });
  probe.truthy("all three come back from a coding query", ["table-driven", "test title", "does not own"].every((word) => found.includes(word)));

  const firstId = Number(found.split("\n").find((line) => line.includes("table-driven")).match(/r#(\d+)/)[1]);
  const superseded = await call(client, "brain_learn", { text: a.text, tags: "testing style" });
  probe.says("the same wording with new tags supersedes that rule", superseded, `superseded r#${firstId}`);
  probe.count("the supersede retires exactly one rule", (superseded.match(/superseded/g) ?? []).length, 1);

  const after = await call(client, "brain_recall", { query: "coding" });
  probe.truthy("the two other rules stay active", after.includes("test title") && after.includes("does not own"));
  probe.silent("the superseded rule stops matching searches", after, "table-driven");
  probe.says("the superseded rule stays in the export", await call(client, "brain_export", {}), "table-driven");

  const retry = await call(client, "brain_remember", { items: [{ text: "The shed door code is 9 0 2 1", tags: "home code" }] });
  probe.truthy("an unrelated write still stores", retry.startsWith("stored #"));
}

async function authorityOnlyWithRules(client, probe) {
  await call(client, "brain_remember", { items: [{ text: "The studio key is under the fern", tags: "home key" }] });
  probe.silent("a note-only recall carries no authority paragraph", await call(client, "brain_recall", { query: "studio fern" }), "outrank");
  probe.silent("brain_remember mentions no rule", await call(client, "brain_remember", { items: [{ text: "The bin collector's name is Sam", tags: "home people" }] }), "outrank");
  probe.silent("brain_patch mentions no rule", await call(client, "brain_patch", { id: 1, confirm: "garage", text: "The garage door code is 4417 today" }), "outrank");
}

async function caps(client, probe) {
  const long = "x".repeat(301);
  await refused(probe, "a note over the cap is refused", () => call(client, "brain_remember", { items: [{ text: long, tags: "cap" }] }));
  const exported = await call(client, "brain_export", {});
  probe.silent("the over-long note stored nothing", exported, long);

  await refused(probe, "a rule carrying a link is refused", () => call(client, "brain_learn", { text: "The wiki is at https://example.com/page", tags: "links" }));
  await refused(probe, "a rule without tags is refused", () => call(client, "brain_learn", { text: "Write short rules", tags: "" }));
}

async function confirmGuard(client, probe) {
  const stored = await call(client, "brain_remember", { items: [{ text: "The router admin password is heron-42", tags: "home network" }] });
  const id = Number(stored.match(/#(\d+)/)[1]);
  await refused(probe, "a patch whose confirm is not in the note is refused", () => call(client, "brain_patch", { id, confirm: "wrong fragment", text: "The router admin password is heron-43" }));
  probe.says("a patch with a real fragment works", await call(client, "brain_patch", { id, confirm: "heron-42", text: "The router admin password is heron-43" }), `patched #${id}`);
  await refused(probe, "a forget whose confirm is not in the note is refused", () => call(client, "brain_forget", { id, confirm: "wrong fragment" }));
  probe.says("a forget with a real fragment works", await call(client, "brain_forget", { id, confirm: "heron-43" }), `forgot #${id}`);
}

async function retirement(client, probe) {
  await call(client, "brain_learn", { text: "Always open a changelog with its date", tags: "changelog" });
  const id = Number((await call(client, "brain_recall", { query: "changelog" })).match(/r#(\d+)/)[1]);
  probe.says("a retired rule answers retired", await call(client, "brain_unlearn", { id, confirm: "open a changelog" }), "retired");
  probe.silent("a retired rule stops matching searches", await call(client, "brain_recall", { query: "changelog" }), "Always open a changelog");
  probe.says("a retired rule stays in the export", await call(client, "brain_export", {}), "Always open a changelog");
}

function rawRequest(host, path) {
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT }, () => {
      socket.end(
        `POST ${path} HTTP/1.1\r\nHost: ${host}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
    let body = "";
    socket.on("data", (chunk) => (body += chunk));
    socket.on("end", () => resolve(body));
    socket.on("error", reject);
  });
}

async function hostGuard(client, probe) {
  const refusedHost = await rawRequest("evil.example.com", "/mcp");
  probe.report("a foreign Host header is refused", refusedHost.startsWith("HTTP/1.1 403"), `actual: ${refusedHost.split("\r\n")[0]}`);

  const allowedHost = await rawRequest("127.0.0.1:8899", "/mcp");
  probe.report("the dev host is not refused with 403", !allowedHost.startsWith("HTTP/1.1 403"), `actual: ${allowedHost.split("\r\n")[0]}`);
}

const checks = [ranked, syntaxGuard, tagConvergence, dedupe, supersede, authorityOnlyWithRules, caps, confirmGuard, retirement, hostGuard];

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), "brain-protocol-check-"));
  const server = startDevServer(stateDir);
  const stop = () => {
    server.kill("SIGTERM");
    rmSync(stateDir, { recursive: true, force: true });
  };
  process.on("exit", stop);

  const probe = new Probe();
  try {
    await waitForHealth();
    const client = await connect();
    for (const check of checks) await check(client, probe);
    await client.close();
  } finally {
    stop();
  }

  console.log(`\n${probe.passed} passed, ${probe.failures.length} failed`);
  for (const name of probe.failures) console.log(`  ${name}`);
  process.exit(probe.failures.length === 0 ? 0 : 1);
}

main();
