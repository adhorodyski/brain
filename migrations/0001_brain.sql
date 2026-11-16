CREATE TABLE IF NOT EXISTS notes (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  at   TEXT NOT NULL,
  dkey TEXT UNIQUE
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_ft USING fts5(text, tags, content='notes', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_ft(notes_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO notes_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_ft(notes_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
END;

CREATE TABLE IF NOT EXISTS rules (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  text   TEXT NOT NULL,
  tags   TEXT NOT NULL,
  at     TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  dkey   TEXT UNIQUE
);

CREATE VIRTUAL TABLE IF NOT EXISTS rules_ft USING fts5(text, tags, content='rules', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS rules_ai AFTER INSERT ON rules BEGIN
  INSERT INTO rules_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS rules_au AFTER UPDATE ON rules BEGIN
  INSERT INTO rules_ft(rules_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO rules_ft(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS rules_ad AFTER DELETE ON rules BEGIN
  INSERT INTO rules_ft(rules_ft, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
END;
