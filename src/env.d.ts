export {};

declare global {
  interface Env {
    BRAIN_DB: D1Database;

    BRAIN_HOSTNAME?: string;
    MAX_NOTE?: string;
  }
}
