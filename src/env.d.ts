export {};

declare global {
  interface Env {
    Assistant: DurableObjectNamespace<import("./assistant").Assistant>;

    /** Names the brain and its Durable Object. Default "brain". */
    BRAIN_NAME?: string;
    /** Used for the clock in the brain's prompt and for scheduled times. Default "UTC". */
    TIMEZONE?: string;

    /** OpenAI-compatible endpoint root, e.g. https://api.example.com/v1 */
    MODEL_BASE_URL: string;
    /** Sent verbatim in the request body, so use whatever that endpoint expects. */
    MODEL_ID: string;
    MODEL_API_KEY: string;
    /** Optional, and only needed past the defaults below. */
    MODEL_CONTEXT_WINDOW?: string;
    MODEL_MAX_TOKENS?: string;
    MODEL_REASONING?: string;

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
