import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.BRAIN_URL ?? "http://127.0.0.1:8799/mcp");
const check = process.env.CHECK ?? "behaviour";
const results = [];

const claim = (label, actual, expected) => {
  const ok = expected === undefined ? Boolean(actual) : actual === expected;
  results.push({ label, ok, actual: String(actual).slice(0, 260), expected: String(expected).slice(0, 260) });
};

const client = new Client({ name: "probe", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));

const call = (tool, args) => client.callTool({ name: tool, arguments: args }).then((r) => r.content[0].text);
const tools = await client.listTools();
const described = Object.fromEntries(
  tools.tools.map((t) => [t.name, JSON.stringify(t.inputSchema) + " " + JSON.stringify(t.description ?? "")]),
);

const idOf = (line, prefix) => Number(line.match(new RegExp(`${prefix}(\\d+)`))[1]);

if (check === "behaviour") {
  const note = await call("brain_remember", {
    items: [{ text: "The garage code is 4417 at the house", tags: "home garage", tier: "core" }],
  });
  const noteId = idOf(note, "#");
  claim("remember echoes core fill", /core \d+\/3150 \(1%\)/.test(note), true);

  const ranked = await call("brain_recall", { query: "4417" });
  claim("garage note ranks first", ranked.includes(`#${noteId}`), true);

  const nearTag = await call("brain_remember", { items: [{ text: "Bin day is Tuesday", tags: "garag" }] });
  claim("near-miss tag echoes stored tag", nearTag.includes('existing tag: "garage"'), true);

  const twice = await call("brain_remember", { items: [{ text: "Bin day is Tuesday", tags: "garag" }] });
  claim("same write twice reports again", twice.includes("again, same call"), true);

  await call("brain_learn", { text: "Assert behaviour, not implementation", topics: "testing" });
  const ruleB = await call("brain_learn", { text: "Write the failing test first, always", topics: "testing" });
  claim("distinct wording sharing a topic both survive", ruleB.includes("2 of 2"), true);

  const firedByOwnWords = await call("brain_recall", { query: "Assert behaviour, not implementation" });
  const ruleAId = idOf(firedByOwnWords, "r#");
  claim("own words return the rule", Number.isInteger(ruleAId), true);
  claim("authority paragraph rides with it", firedByOwnWords.includes("These are the owner's own rules"), true);

  const factOnly = await call("brain_recall", { query: "4417" });
  claim("fact-only recall has no authority paragraph", factOnly.includes("outrank"), false);

  const miss = await call("brain_recall", { query: "zebra unicorn plutonium" });
  claim("empty recall is final", miss.startsWith("nothing stored matching"), true);

  for (const junk of ['"', "((x", "\\", '"OR"', "   ", ""]) {
    const noisy = await call("brain_recall", { query: junk });
    claim(`no fts5 syntax error for ${JSON.stringify(junk)}`, noisy.includes("fts5: syntax error"), false);
  }

  const patched = await call("brain_patch", { id: noteId, confirm: "garage code", text: "The garage code is 4418" });
  claim("patch with a real fragment works", patched.startsWith("patched #"), true);

  const badPatch = await call("brain_patch", { id: noteId, confirm: "kettle", text: "whatever" });
  claim(
    "patch rejects a foreign fragment byte-identically",
    badPatch,
    `#${noteId} does not contain "kettle"; it reads "The garage code is 4418". Nothing changed — brain_patch needs a fragment of that note's own text`,
  );
  const emptyPatch = await call("brain_patch", { id: noteId, confirm: "", text: "whatever" });
  claim("empty confirm is rejected", emptyPatch.includes("does not contain"), true);

  const codingWords = "Name the failing behaviour in the test title";
  await call("brain_learn", { text: codingWords, topics: "coding tests" });
  await call("brain_learn", { text: "Cover the edge case before the happy path", topics: "coding style" });
  const coding3 = await call("brain_learn", { text: "One assert per behaviour in a review", topics: "coding review" });
  const codingQuery = await call("brain_recall", { query: "coding" });
  const liveRules = (codingQuery.match(/r#\d+/g) ?? []).filter((id, index, all) => all.indexOf(id) === index);
  claim("three distinct rules sharing topic coding all come back", liveRules.length, 3);
  claim("the third reports five live rules", coding3.includes("5 of 5"), true);
  const restated = await call("brain_learn", { text: codingWords, topics: "tests" });
  const retiredId = (restated.match(/superseded (r#\d+)/) ?? [])[1];
  claim("identical wording with new topics supersedes one rule", retiredId === undefined, false);
  claim("supersede retires exactly one of the three", restated.includes("5 of 6"), true);
  const afterSupersede = await call("brain_recall", { query: "coding" });
  const survivors = liveRules.filter((id) => id !== retiredId);
  claim("the two untouched coding rules still match", survivors.every((id) => afterSupersede.includes(id)), true);
  claim("the superseded rule stops matching", afterSupersede.includes(retiredId), false);

  const badUnlearn = await call("brain_unlearn", { id: ruleAId, confirm: "kettle" });
  claim(
    "unlearn rejects a foreign fragment byte-identically",
    badUnlearn,
    `instruction r#${ruleAId} does not contain "kettle"; it reads "Assert behaviour, not implementation". Nothing changed — brain_unlearn needs a fragment of that rule's own words`,
  );
  const emptyUnlearn = await call("brain_unlearn", { id: ruleAId, confirm: "" });
  claim("unlearn rejects an empty confirm", emptyUnlearn.includes("does not contain"), true);
  const retired = await call("brain_unlearn", { id: ruleAId, confirm: "Assert behaviour" });
  claim("unlearn retires", retired.startsWith("retired"), true);

  const afterRetire = await call("brain_recall", { query: "Assert behaviour, not implementation" });
  claim("retired rule stops matching", afterRetire.includes(`r#${ruleAId}`), false);

  const badForget = await call("brain_forget", { id: noteId, confirm: "kettle" });
  claim(
    "forget rejects a foreign fragment byte-identically",
    badForget,
    `#${noteId} does not contain "kettle"; it reads "The garage code is 4418". Nothing deleted — brain_forget needs a fragment of that note's own text`,
  );
  const forgotten = await call("brain_forget", { id: noteId, confirm: "garage" });
  claim("forget deletes", forgotten.startsWith("forgot #"), true);

  const exported = await client.callTool({ name: "brain_export", arguments: {} });
  const payload = exported.structuredContent;
  claim("retired rule stays in export", payload.instructions.some((r) => r.id === ruleAId && !r.active), true);
  claim("export has no rules the query did not earn", JSON.stringify(exported).includes("Standing instructions"), false);

  const overBudget = await call("brain_remember", {
    items: [{ text: "x".repeat(400), tier: "core" }],
  });
  claim("core write over the note cap stores nothing", overBudget.includes("at most 300 characters"), true);

  claim("no tool result mentions rules it did not match", JSON.stringify(results).includes("outrank"), false);
}

if (check === "caps") {
  const maxNote = process.env.EXPECT_MAX_NOTE;
  const maxRule = process.env.EXPECT_MAX_RULE;
  const remember = described.brain_remember;
  const patch = described.brain_patch;
  const learn = described.brain_learn;
  claim("remember text description states MAX_NOTE", remember.includes(`at most ${maxNote} characters`), true);
  claim("patch text description states MAX_NOTE", patch.includes(`at most ${maxNote} characters`), true);
  claim("learn description states MAX_RULE", learn.includes(`at most ${maxRule} characters`), true);
  claim("learn arg description states MAX_RULE", learn.includes(`at most ${maxRule} characters`), true);
  if (maxNote !== "300") claim("no hardcoded 300 in descriptions", remember.includes("at most 300 characters"), false);

  const refused = await call("brain_remember", { items: [{ text: "y".repeat(Number(maxNote) + 30) }] });
  claim("error quotes the same cap", refused.includes(`at most ${maxNote} characters`), true);

  const ruleRefused = await call("brain_learn", { text: "z".repeat(210), topics: "testing" });
  claim("rule cap error and description agree", ruleRefused.includes(`at most ${maxRule} characters`), true);

  const serverInfo = await client.getServerVersion();
  claim("server version matches package.json", serverInfo.version, process.env.EXPECT_VERSION);
}

if (check === "limits") {
  const note = await call("brain_remember", { items: [{ text: "Budget probe note", tags: "probe", tier: "core" }] });
  const printed = (note.match(/core \d+\/(\d+)/) ?? ["unprintable: " + note])[1];
  claim(`core budget denominator (${process.env.EXPECT_LABEL})`, printed, process.env.EXPECT_LIMIT);
}

if (check === "fractional") {
  const note = await call("brain_remember", { items: [{ text: "Fractional budget probe", tags: "probe" }] });
  claim("fractional MAX_NOTE falls back so writes still land", note.startsWith("stored #"), true);
  const core = await call("brain_remember", { items: [{ text: "Fractional core probe", tags: "probe", tier: "core" }] });
  claim("fractional CORE_TOKENS falls back to a whole budget", (core.match(/core \d+\/(\d+)/) ?? ["0"])[1], "3150");
}

if (check === "tiebreak") {
  await call("brain_remember", { items: [{ text: "First stored tag note", tags: "bb" }] });
  await call("brain_remember", { items: [{ text: "Second stored tag note", tags: "aa" }] });
  const tie = await call("brain_remember", { items: [{ text: "Equidistant tag note", tags: "ab" }] });
  claim("equidistant stored tags break the tie alphabetically", tie.includes('existing tag: "aa"'), true);
}

if (check === "tagscan") {
  await call("brain_remember", { items: [{ text: "The oldest tagged note", tags: "kapparot" }] });
  for (let batch = 0; batch < 26; batch += 1) {
    const items = Array.from({ length: 20 }, (_, offset) => {
      const index = batch * 20 + offset + 1;
      return { text: `Scan row ${index} holds one filler tag`, tags: `w${String(index).padStart(3, "0")}` };
    });
    await call("brain_remember", { items });
  }
  await call("brain_remember", { items: [{ text: "The newest tagged note", tags: "omegarot" }] });
  const recent = await call("brain_remember", { items: [{ text: "Near miss of the newest tag", tags: "omegaroe" }] });
  claim("a tag inside the scan window still echoes", recent.includes('existing tag: "omegarot"'), true);
  const aged = await call("brain_remember", { items: [{ text: "Near miss of the oldest tag", tags: "kapparoe" }] });
  claim("the scan reads a window, not the whole archive", aged.includes("existing tag"), false);
}

await client.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.label}${r.ok ? "" : `\n     actual:   ${r.actual}\n     expected: ${r.expected}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
