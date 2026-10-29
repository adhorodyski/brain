import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startDevServer } from "./dev-server.mjs";

const PORT = Number(process.env.PROBE_PORT ?? 8899);

let passed = 0;
const failures = [];

function check(name, ok, actual) {
  if (ok) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}\n     actual: ${JSON.stringify(actual)}`);
  }
}

function answers(checkName, text, expected) {
  check(checkName, text.includes(expected), text);
}

function staysOut(checkName, text, fragment) {
  check(checkName, !text.includes(fragment), `${text} mentions ${fragment}`);
}

async function refused(checkName, attempt) {
  check(checkName, await attempt().then(() => false, () => true), "the call was accepted");
}

const connect = async () => {
  const client = new Client({ name: "protocol-check", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  return client;
};

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
  if (result.isError) throw new Error(text);
  return text;
}

const noteIdFrom = (text) => Number(text.match(/#(\d+)/)[1]);

const checks = {
  "the 4417 ranking": async (client) => {
    await call(client, "brain_remember", {
      items: [
        { text: "The garage door code is 4417", tags: "home code" },
        { text: "The meeting room booking for 4417 was cancelled", tags: "work" },
      ],
    });
    const found = await call(client, "brain_recall", { query: "4417" });
    check("a query of 4417 ranks the garage note first", found.indexOf("garage") >= 0 && found.indexOf("garage") < found.indexOf("meeting"), found);
  },

  "the syntax guard": async (client) => {
    for (const query of ['"', "((x", "\\", '"OR"', "  ", ""]) {
      staysOut(`query ${JSON.stringify(query)} raises no fts5 syntax error`, await call(client, "brain_recall", { query }), "fts5: syntax error");
    }
  },

  "tag convergence": async (client) => {
    await call(client, "brain_remember", { items: [{ text: "The mailbox collection is at noon", tags: "noon" }] });
    answers(
      "a near-miss tag in notes echoes the stored tag",
      await call(client, "brain_remember", { items: [{ text: "Bin day is Tuesday morning", tags: "novn" }] }),
      'existing tag: "noon"',
    );

    await call(client, "brain_learn", { text: "Never use em dashes in replies to the owner", tags: "dashes" });
    answers(
      "a near-miss tag in rules echoes the stored tag",
      await call(client, "brain_learn", { text: "Keep replies free of decorative punctuation", tags: "dashe" }),
      'existing tag: "dashes"',
    );

    staysOut(
      "a distant tag echoes nothing",
      await call(client, "brain_learn", { text: "Commit messages use the imperative mood", tags: "commits" }),
      "existing tag",
    );
  },

  "write dedupe": async (client) => {
    const note = { text: "The wifi password is sunset-lagoon", tags: "home wifi" };
    await call(client, "brain_remember", { items: [note] });
    answers("the same write twice reports again, same call", await call(client, "brain_remember", { items: [note] }), "(again, same call)");
    const exportText = await call(client, "brain_export", {});
    check("the repeated write stored one row", exportText.split("sunset-lagoon").length === 2, exportText);
  },

  "supersede by wording": async (client) => {
    const sharedTag = { text: "Prefer table-driven tests over one test per case", tags: "coding" };
    await call(client, "brain_learn", sharedTag);
    await call(client, "brain_learn", { text: "Name the behaviour in the test title", tags: "coding" });
    await call(client, "brain_learn", { text: "Never mock a class the module does not own", tags: "coding" });

    const found = await call(client, "brain_recall", { query: "coding" });
    check("three rules sharing a tag all come back", ["table-driven", "test title", "does not own"].every((words) => found.includes(words)), found);

    const firstId = Number(found.split("\n").find((line) => line.includes("table-driven")).match(/r#(\d+)/)[1]);
    const again = await call(client, "brain_learn", { text: sharedTag.text, tags: "testing style" });
    answers("the same wording with new tags supersedes that rule", again, `superseded r#${firstId}`);

    const after = await call(client, "brain_recall", { query: "coding" });
    check("the two other rules stay active", after.includes("test title") && after.includes("does not own"), after);
    staysOut("the superseded rule stops matching searches", after, "table-driven");
    answers("the superseded rule stays in the export", await call(client, "brain_export", {}), "table-driven");
  },

  "no authority without a matched rule": async (client) => {
    await call(client, "brain_remember", { items: [{ text: "The studio key is under the fern", tags: "home key" }] });
    staysOut("a note-only recall carries no authority paragraph", await call(client, "brain_recall", { query: "studio fern" }), "outrank");
    staysOut("a note write mentions no rule", await call(client, "brain_remember", { items: [{ text: "The bin collector's name is Sam", tags: "home people" }] }), "outrank");
  },

  "the caps": async (client) => {
    const long = "x".repeat(301);
    await refused("a note over the cap is refused", () => call(client, "brain_remember", { items: [{ text: long, tags: "cap" }] }));
    staysOut("the over-long note stored nothing", await call(client, "brain_export", {}), long);
    await refused("a rule carrying a link is refused", () => call(client, "brain_learn", { text: "The wiki is at https://example.com/page", tags: "links" }));
    await refused("a rule without tags is refused", () => call(client, "brain_learn", { text: "Write short rules", tags: "" }));
  },

  "the confirm guard": async (client) => {
    const stored = await call(client, "brain_remember", { items: [{ text: "The router admin password is heron-42", tags: "home network" }] });
    const id = noteIdFrom(stored);
    await refused("a patch whose confirm is not in the note is refused", () => call(client, "brain_patch", { id, confirm: "wrong fragment", text: "The router admin password is heron-43" }));
    answers("a patch with a real fragment works", await call(client, "brain_patch", { id, confirm: "heron-42", text: "The router admin password is heron-43" }), `patched #${id}`);
    await refused("a forget whose confirm is not in the note is refused", () => call(client, "brain_forget", { id, confirm: "wrong fragment" }));
    answers("a forget with a real fragment works", await call(client, "brain_forget", { id, confirm: "heron-43" }), `forgot #${id}`);
  },

  "retirement": async (client) => {
    await call(client, "brain_learn", { text: "Always open a changelog with its date", tags: "changelog" });
    const id = Number((await call(client, "brain_recall", { query: "changelog" })).match(/r#(\d+)/)[1]);
    answers("a retired rule answers retired", await call(client, "brain_unlearn", { id, confirm: "open a changelog" }), "retired");
    staysOut("a retired rule stops matching searches", await call(client, "brain_recall", { query: "changelog" }), "Always open a changelog");
    answers("a retired rule stays in the export", await call(client, "brain_export", {}), "Always open a changelog");
  },

  "the host guard": async () => {
    const foreign = await rawRequest("evil.example.com");
    check("a foreign Host header gets 403", foreign.startsWith("HTTP/1.1 403"), foreign.split("\r\n")[0]);
    const local = await rawRequest(`127.0.0.1:${PORT}`);
    check("the dev host is not refused", !local.startsWith("HTTP/1.1 403"), local.split("\r\n")[0]);
  },
};

function rawRequest(host) {
  const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT }, () => {
      socket.end(`POST /mcp HTTP/1.1\r\nHost: ${host}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
    });
    let response = "";
    socket.on("data", (chunk) => (response += chunk));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

const stateDir = mkdtempSync(join(tmpdir(), "brain-probe-"));
const watchdog = setTimeout(() => {
  console.error("the probe ran past its 5 minute cap and gave up rather than hanging");
  process.exit(1);
}, 300_000);
const { child, ready } = startDevServer(PORT, stateDir);
process.on("exit", () => {
  child.kill("SIGTERM");
  rmSync(stateDir, { recursive: true, force: true });
});

try {
  await ready;
  const client = await connect();
  for (const check of Object.values(checks)) await check(client);
  await client.close();
} catch (error) {
  failures.push(error.message);
  console.error(error.message);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
