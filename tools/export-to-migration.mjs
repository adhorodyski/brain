import { readFile } from "node:fs/promises";

const input = process.argv[2];
if (!input) {
  console.error(
    "usage: node tools/export-to-migration.mjs export.json > migrations/0002_import.sql\n" +
      "  export.json is the structuredContent from a brain_export tool result.\n" +
      "  --keep-keys imports the exported dedupe keys instead of deriving them from the text.",
  );
  process.exit(1);
}

const RECOMPUTE = !process.argv.includes("--keep-keys");

const payload = JSON.parse(await readFile(input, "utf8"));

const digest = async (parts) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
if (!Array.isArray(payload.notes) || !Array.isArray(payload.rules)) {
  console.error("export.json needs arrays named notes and rules");
  process.exit(1);
}

const quote = (value) => `'${String(value ?? "").replaceAll("'", "''")}'`;
const nullable = (value) => (value === null || value === undefined ? "NULL" : quote(value));
const missing = (row, fields) => fields.filter((field) => row[field] === undefined);

const seen = new Set();
const reject = (label, row, fields) => {
  const absent = missing(row, fields);
  if (absent.length > 0) {
    console.error(`${label} id ${row.id} is missing ${absent.join(", ")}`);
    process.exit(1);
  }
  if (!Number.isInteger(row.id) || row.id < 1) {
    console.error(`${label} id ${row.id} is not a positive integer`);
    process.exit(1);
  }
  if (seen.has(`${label}#${row.id}`)) {
    console.error(`${label} id ${row.id} appears twice`);
    process.exit(1);
  }
  seen.add(`${label}#${row.id}`);
};

if (!RECOMPUTE) {
  const keyless = [...payload.notes, ...payload.rules].filter((row) => row.dkey === undefined).length;
  if (keyless > 0) {
    console.error(
      `--keep-keys asked for ${keyless} row(s) with no exported dedupe key. Drop the flag to derive them.`,
    );
    process.exit(1);
  }
}

const lines = [];
let highest = 0;

const claims = new Set();
const keyed = async (row, parts) => {
  if (!RECOMPUTE) return nullable(row.dkey);
  if (row.active === false) return "NULL";
  const key = await digest(parts);
  if (claims.has(key)) return "NULL";
  claims.add(key);
  return quote(key);
};

for (const note of payload.notes) {
  reject("note", note, ["text", "tags", "storedAt"]);
  highest = Math.max(highest, note.id);
  const dkey = await keyed(note, [note.text, note.tags]);
  lines.push(
    `INSERT INTO notes (id, text, tags, at, dkey) VALUES (${note.id}, ${quote(note.text)}, ${quote(
      note.tags,
    )}, ${quote(note.storedAt)}, ${dkey});`,
  );
}
for (const rule of payload.rules) {
  reject("rule", rule, ["text", "tags", "storedAt", "active"]);
  highest = Math.max(highest, rule.id);
  const dkey = await keyed(rule, [rule.tags, rule.text]);
  lines.push(
    `INSERT INTO rules (id, text, tags, at, active, dkey) VALUES (${rule.id}, ${quote(rule.text)}, ${quote(
      rule.tags,
    )}, ${quote(rule.storedAt)}, ${rule.active ? 1 : 0}, ${dkey});`,
  );
}

lines.push(`UPDATE sqlite_sequence SET seq = ${highest} WHERE name IN ('notes', 'rules');`);
lines.push(`INSERT INTO notes_ft(notes_ft) VALUES ('rebuild');`);
lines.push(`INSERT INTO rules_ft(rules_ft) VALUES ('rebuild');`);

console.log(lines.join("\n"));
