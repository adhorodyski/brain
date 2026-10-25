export {};

declare global {
  interface Env {
    Brain: DurableObjectNamespace<import("./brain").Brain>;

    BRAIN_HOSTNAME?: string;
    CORE_TOKENS?: string;
    MAX_NOTE?: string;
  }
}
