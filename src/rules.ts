import {
  flat,
  nearDuplicates,
  toFtsQuery,
  wordList,
  type CountRow,
  type IdRow,
  type SqlPort,
} from "./store";

export const MAX_RULE = 200;
const MATCH_LIMIT = 3;

const NOT_BEHAVIOUR: [RegExp, string][] = [
  [/https?:\/\/|\bwww\./i, "a link"],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/, "an email address"],
  [/```|~~~/, "a code fence"],
];

const sameWords = (left: string, right: string) => wordList(left).join(" ") === wordList(right).join(" ");

type RuleMatchRow = { id: number; text: string; topics: string };
type RuleCandidateRow = { id: number; text: string };
type RuleStateRow = { id: number; text: string; active: number };
type StoredTopicsRow = { topics: string };

export type RuleExportRow = {
  id: number;
  text: string;
  topics: string;
  storedAt: string;
  active: number;
  supersededKey: string | null;
};

export function createRuleStore(port: SqlPort) {
  const fill = () => {
    const active = port.sql<CountRow>("SELECT COUNT(*) AS n FROM rules WHERE active = 1")[0]?.n ?? 0;
    const total = port.sql<CountRow>("SELECT COUNT(*) AS n FROM rules")[0]?.n ?? 0;
    return `${active} of ${total}`;
  };

  const ruleLine = (row: RuleMatchRow) =>
    `r#${row.id} · ${row.text} ${wordList(row.topics).map((topic) => `#${topic}`).join(" ")}`;

  const storedTopics = () =>
    [...new Set(port.sql<StoredTopicsRow>("SELECT DISTINCT topics FROM rules").flatMap((row) => wordList(row.topics)))];

  function match(query: string): string[] {
    const rows = port.sql<RuleMatchRow>(
      `SELECT rules.rowid AS id, rules.text AS text, rules.topics AS topics
        FROM rules_ft JOIN rules ON rules.rowid = rules_ft.rowid
        WHERE rules_ft MATCH ? AND rules.active = 1
        ORDER BY bm25(rules_ft, 1.0, 5.0) LIMIT ?`,
      [toFtsQuery(query), MATCH_LIMIT],
    );
    return rows.map(ruleLine);
  }

  async function learn(text: string, topicsRaw: string): Promise<string> {
    const body = flat(text);
    if (body.length === 0) throw new Error("empty text teaches nothing");
    if (body.length > MAX_RULE) {
      throw new Error(
        `an instruction is at most ${MAX_RULE} characters and that is ${body.length}: make it ${body.length - MAX_RULE} shorter, or keep the detail in a note with brain_remember`,
      );
    }
    const found = NOT_BEHAVIOUR.find(([pattern]) => pattern.test(body));
    if (found) {
      throw new Error(
        `instructions hold rules of behaviour, so ${found[1]} has no place in one and nothing was stored. State the rule on its own`,
      );
    }
    const topics = wordList(topicsRaw);
    if (topics.length === 0) {
      throw new Error(
        "an instruction needs topics: the words a search will use to find it, such as testing, prs, or prose. Nothing was stored",
      );
    }

    const key = await port.digest([topics.join(" "), body]);
    return port.transaction(() => {
      if (port.sql<IdRow>("SELECT rowid AS id FROM rules WHERE dkey = ?", [key])[0]) {
        return `stored · again, same call · ${fill()}`;
      }

      const candidates = port.sql<RuleCandidateRow>(
        "SELECT rowid AS id, text AS text FROM rules WHERE active = 1",
      );
      const retired = candidates.filter((row) => sameWords(row.text, body));

      const keyOfMine = crypto.randomUUID();
      for (const row of retired) {
        port.sql("UPDATE rules SET active = 0, superseded_key = ?, dkey = NULL WHERE rowid = ?", [
          keyOfMine,
          row.id,
        ]);
      }
      port.sql(
        `INSERT INTO rules (key, text, topics, at, active, superseded_key, dkey)
          VALUES (?, ?, ?, ?, 1, NULL, ?)`,
        [keyOfMine, body, topics.join(" "), new Date().toISOString(), key],
      );
      const echo = nearDuplicates(storedTopics(), topics)
        .filter((topic) => !topics.includes(topic))
        .map((topic) => `existing topic: "${topic}"`);
      const superseded = retired.map((row) => `superseded r#${row.id}`);
      return [`stored · ${fill()}`, ...superseded, ...echo].join(" · ");
    });
  }

  function unlearn(ruleId: number, confirm: string): string {
    const wanted = flat(confirm);
    return port.transaction(() => {
      const row = port.sql<RuleStateRow>(
        "SELECT rowid AS id, text AS text, active AS active FROM rules WHERE rowid = ?",
        [ruleId],
      )[0];
      if (!row) {
        throw new Error(
          `nothing stored as instruction r#${ruleId}; brain_recall and brain_learn print the id of every live rule`,
        );
      }
      if (row.active === 0) return `retired · ${fill()}`;
      if (wanted.length === 0 || !row.text.includes(wanted)) {
        throw new Error(
          `instruction r#${ruleId} does not contain "${wanted}"; it reads "${row.text}". Nothing changed — brain_unlearn needs a fragment of that rule's own words`,
        );
      }
      port.sql("UPDATE rules SET active = 0, dkey = NULL WHERE rowid = ?", [ruleId]);
      return `retired · ${fill()}`;
    });
  }

  function rules(): RuleExportRow[] {
    return port.sql<RuleExportRow>(
      `SELECT rowid AS id, text AS text, topics AS topics, at AS storedAt,
        active AS active, superseded_key AS supersededKey
        FROM rules ORDER BY rowid`,
    );
  }

  return { match, learn, unlearn, rules };
}
