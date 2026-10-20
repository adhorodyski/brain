import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createMemory, SCHEMA } from "../src/store.ts";

function memory() {
  const db = new DatabaseSync(":memory:");
  for (const statement of SCHEMA) db.exec(statement);
  return createMemory({
    sql: (statement, values) =>
      Array.from(db.prepare(statement).all(...((values ?? []) as SQLInputValue[]))) as Record<string, unknown>[],
    arm: async () => ({ id: "armed" }),
    disarm: async () => true,
  });
}

const handle = (line: string) => Number(/#(\d+)/.exec(line)?.[1]);
const lineAbout = (lines: string[], needle: string) => lines.find((line) => line.includes(needle));

test("recall hands back a handle per note", () => {
  const brain = memory();
  brain.rememberBatch([{ text: "Physio on Tuesdays", tags: "health" }], "batch1");

  const found = brain.search("physio");
  assert.equal(found.total, 1);
  assert.match(found.lines[0]!, /#\d+/);
});

test("forget removes the note a handle points at and echoes its text", () => {
  const brain = memory();
  brain.rememberBatch([{ text: "Physio on Tuesdays" }, { text: "Dentist every 6 months" }], "batch1");

  const target = handle(lineAbout(brain.search("physio").lines, "Physio")!);
  const said = brain.forget(target, "Tuesdays");

  assert.match(said, /Physio on Tuesdays/);
  assert.equal(brain.search("physio").total, 0);
  assert.equal(brain.search("dentist").total, 1, "the neighbour note survives");
});

test("forget refuses when the handle has moved to other text", () => {
  const brain = memory();
  brain.rememberBatch([{ text: "Physio on Tuesdays" }, { text: "Dentist every 6 months" }], "batch1");

  const target = handle(lineAbout(brain.search("physio").lines, "Physio")!);
  const said = brain.forget(target, "Dentist");

  assert.match(said, /Physio on Tuesdays/, "shows what actually sits at that handle");
  assert.equal(brain.search("physio").total, 1, "nothing was removed");
});

test("forget refuses a handle no note carries", () => {
  const brain = memory();
  brain.rememberBatch([{ text: "Physio on Tuesdays" }], "batch1");

  const said = brain.forget(987654, "Physio");

  assert.match(said, /987654/);
  assert.equal(brain.search("physio").total, 1);
});

test("forget refuses without something to confirm against", () => {
  const brain = memory();
  brain.rememberBatch([{ text: "Physio on Tuesdays" }], "batch1");

  const target = handle(brain.search("physio").lines[0]!);
  assert.match(brain.forget(target, "   "), /confirm/);
  assert.equal(brain.search("physio").total, 1, "nothing was removed");
});

test("forget runs twice without taking anything extra", () => {
  const brain = memory();
  brain.rememberBatch([{ text: "Physio on Tuesdays" }, { text: "Dentist every 6 months" }], "batch1");

  const target = handle(lineAbout(brain.search("physio").lines, "Physio")!);
  brain.forget(target, "Tuesdays");
  const again = brain.forget(target, "Tuesdays");

  assert.match(again, /no note/);
  assert.equal(brain.search("dentist").total, 1);
});

test("one note goes and the survivor keeps its handle", () => {
  const brain = memory();
  brain.rememberBatch([{ text: "Old gym code" }, { text: "New gym code" }], "batch1");

  const before = brain.search("gym");
  assert.equal(before.total, 2);
  const surviving = lineAbout(before.lines, "New")!;

  brain.forget(handle(lineAbout(before.lines, "Old")!), "Old gym code");

  const after = brain.search("gym");
  assert.equal(after.total, 1);
  assert.match(after.lines[0]!, /New/);
  assert.equal(handle(after.lines[0]!), handle(surviving), "deleting a neighbour leaves this handle alone");
});

test("a recycled handle cannot take a note nobody named", () => {
  const brain = memory();
  brain.rememberBatch([{ text: "Parking is free on Sundays" }], "batch1");
  const vacated = handle(brain.search("parking").lines[0]!);
  brain.forget(vacated, "Parking");

  brain.rememberBatch([{ text: "Mum's PIN is 9114" }], "batch2");
  const claimant = brain.search("pin").lines[0]!;

  if (handle(claimant) === vacated) {
    assert.match(brain.forget(vacated, "Parking is free"), /not the note you named/);
  }
  assert.equal(brain.search("pin").total, 1, "the note that arrived later survives");
});
