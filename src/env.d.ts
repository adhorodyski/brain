export {};

declare global {
  interface Env {
    BRAIN_DB: D1Database;
    Brain: DurableObjectNamespace;

    BRAIN_HOSTNAME?: string;
    MAX_NOTE?: string;
  }
}
