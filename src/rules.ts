import {
  flat,
  nearMisses,
  toFtsQuery,
  wordList,
  type CountRow,
  type IdRow,
} from "./notes";
import { rowOf, rowsOf, s, type Outcome, type SqlPort, type Statement } from "./db";

export const MAX_RULE = 200;
const MATCH_LIMIT = 3;

const NOT_BEHAVIOUR: [RegExp, string][] = [
  [/https?:\/\/|\bwww\./i, "a link"],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/, "an email address"],
  [/```|~~~/, "a code fence"],
];

const sameWords = (left: string, right: string) => wordList(left).join(" ") === wordList(right).join(" ");

type RuleMatchRow = { id: number; text: string; tags: string };
type RuleCandidateRow = { id: number; text: string };
type RuleStateRow = { id: number; text: string; active: number };
type StoredTagsRow = { tags: string };

export type RuleExportRow = {
  id: number;
  text: string;
  tags: string;
  storedAt: string;
  active: number;
  dkey: string | null;
};

const MATCH_QUERY = `SELECT rules.id, rules.text, rules.tags
  FROM rules_ft JOIN rules ON rules.rowid = rules_ft.rowid
  WHERE rules_ft MATCH ? AND rules.active = 1
  ORDER BY bm25(rules_ft, 1.0, 5.0) LIMIT ?`;

const HELD_BY_DKEY = "SELECT id FROM rules WHERE dkey = ?";
const ACTIVE_CANDIDATES = "SELECT id, text FROM rules WHERE active = 1";
const STORED_RULE_TAGS = "SELECT DISTINCT tags FROM rules";
const FIND_RULE = "SELECT id, text, active FROM rules WHERE id = ?";
const RETIRE_ONE = "UPDATE rules SET active = 0, dkey = NULL WHERE id = ? AND active = 1";
const INSERT_RULE =
  `INSERT INTO rules (text, tags, at, active, dkey) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT (dkey) DO NOTHING`;
const ACTIVE_COUNT = "SELECT COUNT(*) AS n FROM rules WHERE active = 1";
const TOTAL_COUNT = "SELECT COUNT(*) AS n FROM rules";
const ALL_RULES =
  "SELECT id, text, tags, at AS storedAt, active AS active, dkey AS dkey FROM rules ORDER BY id";

const countsLine = (outcomes: readonly Outcome[], first: number) =>
  `${rowOf<CountRow>(outcomes, first)?.n ?? 0} of ${rowOf<CountRow>(outcomes, first + 1)?.n ?? 0}`;

export function createRuleStore(port: SqlPort) {
  const ruleLine = (row: RuleMatchRow) =>
    `r#${row.id} · ${row.text} ${wordList(row.tags).map((tag) => `#${tag}`).join(" ")}`;

  async function match(query: string): Promise<string[]> {
    const outcomes = await port.run([s(MATCH_QUERY, toFtsQuery(query), MATCH_LIMIT)]);
    return rowsOf<RuleMatchRow>(outcomes, 0).map(ruleLine);
  }

  async function learn(raw: string, tagsRaw: string): Promise<string> {
    const text = flat(raw);
    if (text.length === 0) throw new Error("empty text teaches nothing");
    if (text.length > MAX_RULE) {
      throw new Error(
        `a rule is at most ${MAX_RULE} characters and that is ${text.length}: make it ${text.length - MAX_RULE} shorter, or keep the detail in a note with brain_remember`,
      );
    }
    const found = NOT_BEHAVIOUR.find(([pattern]) => pattern.test(text));
    if (found) {
      throw new Error(
        `a rule states behaviour, so ${found[1]} has no place in one and nothing was stored. State the rule on its own`,
      );
    }
    const tags = wordList(tagsRaw);
    if (tags.length === 0) {
      throw new Error(
        "a rule needs tags: the words a search will use to find it, such as testing, prs, or prose. Nothing was stored",
      );
    }

    const key = await port.digest([tags.join(" "), text]);
    const looked = await port.run([
      s(HELD_BY_DKEY, key),
      s(ACTIVE_CANDIDATES),
      s(STORED_RULE_TAGS),
      s(ACTIVE_COUNT),
      s(TOTAL_COUNT),
    ]);

    const dupe = rowOf<IdRow>(looked, 0);
    const retired = rowsOf<RuleCandidateRow>(looked, 1).filter((row) => sameWords(row.text, text));
    const echo = nearMisses(
      [...new Set(rowsOf<StoredTagsRow>(looked, 2).flatMap((row) => wordList(row.tags)))],
      tags,
    )
      .filter((tag) => !tags.includes(tag))
      .map((tag) => `existing tag: "${tag}"`);

    if (dupe) return `stored · again, same call · ${countsLine(looked, 3)}`;

    const write: Statement[] = [
      s(INSERT_RULE, text, tags.join(" "), new Date().toISOString(), key),
      ...retired.map((row) => s(RETIRE_ONE, row.id)),
      s(ACTIVE_COUNT),
      s(TOTAL_COUNT),
    ];
    const outcomes = await port.run(write);
    const superseded = retired.map((row) => `superseded r#${row.id}`);
    return [`stored · ${countsLine(outcomes, retired.length + 1)}`, ...superseded, ...echo].join(" · ");
  }

  async function unlearn(ruleId: number, confirm: string): Promise<string> {
    const wanted = flat(confirm);
    const looked = await port.run([s(FIND_RULE, ruleId), s(ACTIVE_COUNT), s(TOTAL_COUNT)]);
    const found = rowOf<RuleStateRow>(looked, 0);
    if (!found) {
      throw new Error(
        `nothing stored as rule r#${ruleId}; brain_recall and brain_learn print the id of every rule`,
      );
    }
    if (found.active === 0) return `retired · ${countsLine(looked, 1)}`;
    if (wanted.length === 0 || !found.text.includes(wanted)) {
      throw new Error(
        `rule r#${ruleId} does not contain "${wanted}"; it reads "${found.text}". Nothing changed — brain_unlearn needs a fragment of that rule's own text`,
      );
    }
    const outcomes = await port.run([s(RETIRE_ONE, ruleId), s(ACTIVE_COUNT), s(TOTAL_COUNT)]);
    return `retired · ${countsLine(outcomes, 1)}`;
  }

  async function allRules(): Promise<RuleExportRow[]> {
    const outcomes = await port.run([s(ALL_RULES)]);
    return rowsOf<RuleExportRow>(outcomes, 0);
  }

  return { match, learn, unlearn, allRules };
}
