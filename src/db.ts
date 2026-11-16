export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export type Statement = readonly [sql: string, values?: readonly SqlValue[]];

export interface Outcome {
  rows: SqlRow[];
}

export interface SqlPort {
  run(statements: readonly Statement[]): Promise<Outcome[]>;
  digest(parts: readonly string[]): Promise<string>;
}

export const s = (sql: string, ...values: readonly SqlValue[]): Statement => [sql, values];

export const rowsOf = <T extends SqlRow>(outcomes: readonly Outcome[], index: number): T[] =>
  (outcomes[index]?.rows ?? []) as T[];

export const rowOf = <T extends SqlRow>(outcomes: readonly Outcome[], index: number): T | undefined =>
  rowsOf<T>(outcomes, index)[0];

export function createD1Port(db: D1Database): SqlPort {
  return {
    async run(statements) {
      const prepared = statements.map(([sql, values]) => {
        const statement = db.prepare(sql);
        return values && values.length > 0 ? statement.bind(...values) : statement;
      });
      const results = await db.batch(prepared);
      return results.map((result) => ({ rows: (result.results as SqlRow[] | undefined) ?? [] }));
    },
    async digest(parts) {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
      return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
  };
}
