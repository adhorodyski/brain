export interface Column {
  name: string;
  add: string;
}

export interface Table {
  name: string;
  create: string;
  added: readonly Column[];
}

export interface Schema {
  tables: readonly Table[];
  objects: readonly string[];
}

export const SCHEMA: Schema = {
  tables: [
    {
      name: "notes",
      create: `CREATE TABLE IF NOT EXISTS notes (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    text   TEXT NOT NULL,
    tags   TEXT NOT NULL DEFAULT '',
    at     TEXT NOT NULL,
    dkey   TEXT UNIQUE
  )`,
      added: [],
    },
    {
      name: "rules",
      create: `CREATE TABLE IF NOT EXISTS rules (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    text   TEXT NOT NULL,
    tags   TEXT NOT NULL,
    at     TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    dkey   TEXT UNIQUE
  )`,
      added: [],
    },
  ],
  objects: [
    `CREATE VIRTUAL TABLE IF NOT EXISTS notes_ft USING fts5(text, tags, content='notes', content_rowid='rowid')`,
    `CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END`,
    `CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_ft(notes_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
    INSERT INTO notes_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END`,
    `CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_ft(notes_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  END`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS rules_ft USING fts5(text, tags, content='rules', content_rowid='rowid')`,
    `CREATE TRIGGER IF NOT EXISTS rules_ai AFTER INSERT ON rules BEGIN
    INSERT INTO rules_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END`,
    `CREATE TRIGGER IF NOT EXISTS rules_au AFTER UPDATE ON rules BEGIN
    INSERT INTO rules_ft(rules_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
    INSERT INTO rules_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END`,
    `CREATE TRIGGER IF NOT EXISTS rules_ad AFTER DELETE ON rules BEGIN
    INSERT INTO rules_ft(rules_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  END`,
  ],
};

export const addColumn = (table: Table, column: Column): string =>
  `ALTER TABLE ${table.name} ADD COLUMN ${column.name} ${column.add}`;

const hasColumn = (run: (statement: string) => void, table: string, column: string): boolean => {
  try {
    run(`SELECT ${column} FROM ${table} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
};

export const schemaFailureLine = (detail: string): string =>
  `brain could not prepare its schema: ${detail}\n` +
  `Nothing was read or written. If the reason names a column, add it to the 'added' list of that ` +
  `table in src/schema.ts and redeploy.`;

export const ensureSchema = (run: (statement: string) => void, schema: Schema): string | null => {
  try {
    for (const table of schema.tables) {
      run(table.create);
      for (const column of table.added) {
        if (hasColumn(run, table.name, column.name)) continue;
        run(addColumn(table, column));
      }
    }
    for (const statement of schema.objects) run(statement);
    return null;
  } catch (error) {
    return schemaFailureLine(error instanceof Error ? error.message : String(error));
  }
};
