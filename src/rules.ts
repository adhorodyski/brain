import {
  flat,
  nearMisses,
  toFtsQuery,
  wordList,
  type CountRow,
  type IdRow,
  type SqlPort,
} from "./notes";

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
};

export function createRuleStore(port: SqlPort) {
  const retire = (ruleId: number) =>
    port.sql("UPDATE rules SET active = 0, dkey = NULL WHERE id = ?", [ruleId]);

  const counts = () => {
    const active = port.sql<CountRow>("SELECT COUNT(*) AS n FROM rules WHERE active = 1")[0]?.n ?? 0;
    const total = port.sql<CountRow>("SELECT COUNT(*) AS n FROM rules")[0]?.n ?? 0;
    return `${active} of ${total}`;
  };

  const ruleLine = (row: RuleMatchRow) =>
    `r#${row.id} · ${row.text} ${wordList(row.tags).map((tag) => `#${tag}`).join(" ")}`;

  const allTags = () =>
    [...new Set(port.sql<StoredTagsRow>("SELECT DISTINCT tags FROM rules").flatMap((row) => wordList(row.tags)))];

  function match(query: string): string[] {
    const rows = port.sql<RuleMatchRow>(
      `SELECT rules.id, rules.text, rules.tags
        FROM rules_ft JOIN rules ON rules.rowid = rules_ft.rowid
        WHERE rules_ft MATCH ? AND rules.active = 1
        ORDER BY bm25(rules_ft, 1.0, 5.0) LIMIT ?`,
      [toFtsQuery(query), MATCH_LIMIT],
    );
    return rows.map(ruleLine);
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
    return port.transaction(() => {
      if (port.sql<IdRow>("SELECT id FROM rules WHERE dkey = ?", [key])[0]) {
        return `stored · again, same call · ${counts()}`;
      }

      const candidates = port.sql<RuleCandidateRow>(
        "SELECT id, text FROM rules WHERE active = 1",
      );
      const retired = candidates.filter((row) => sameWords(row.text, text));

      port.sql(
        `INSERT INTO rules (text, tags, at, active, dkey)
          VALUES (?, ?, ?, 1, ?)`,
        [text, tags.join(" "), new Date().toISOString(), key],
      );
      for (const row of retired) retire(row.id);
      const echo = nearMisses(allTags(), tags)
        .filter((tag) => !tags.includes(tag))
        .map((tag) => `existing tag: "${tag}"`);
      const superseded = retired.map((row) => `superseded r#${row.id}`);
      return [`stored · ${counts()}`, ...superseded, ...echo].join(" · ");
    });
  }

  function unlearn(ruleId: number, confirm: string): string {
    const wanted = flat(confirm);
    return port.transaction(() => {
      const row = port.sql<RuleStateRow>(
        "SELECT id, text, active FROM rules WHERE id = ?",
        [ruleId],
      )[0];
      if (!row) {
        throw new Error(
          `nothing stored as rule r#${ruleId}; brain_recall and brain_learn print the id of every rule`,
        );
      }
      if (row.active === 0) return `retired · ${counts()}`;
      if (wanted.length === 0 || !row.text.includes(wanted)) {
        throw new Error(
          `rule r#${ruleId} does not contain "${wanted}"; it reads "${row.text}". Nothing changed — brain_unlearn needs a fragment of that rule's own text`,
        );
      }
      retire(ruleId);
      return `retired · ${counts()}`;
    });
  }

  function allRules(): RuleExportRow[] {
    return port.sql<RuleExportRow>(
      `SELECT id, text, tags, at AS storedAt,
        active AS active
        FROM rules ORDER BY id`,
    );
  }

  return { match, learn, unlearn, allRules };
}
