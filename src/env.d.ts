export {};

declare global {
  interface Env {
    Assistant: DurableObjectNamespace<import("./assistant").Assistant>;
    /** Model key for api.callstack.ai. */
    CALLSTACK_API_KEY: string;
    TELEGRAM_BOT_TOKEN: string;
    /** Random string Telegram echoes back on every webhook POST. */
    TELEGRAM_WEBHOOK_SECRET: string;
    /** The only chat the brain answers, and where reminders land. */
    TELEGRAM_CHAT_ID: string;
    /** Bearer token for the terminal door: full tool set. */
    BRAIN_TOKEN: string;
    /** Optional bearer token for the read-only mount. Unset means that mount does not exist. */
    BRAIN_READ_ONLY_TOKEN?: string;
    /** Custom hostname, if the worker serves one. Guards MCP Host validation. */
    BRAIN_HOSTNAME?: string;
  }
}
