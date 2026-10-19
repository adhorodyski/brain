export {};

declare global {
  interface Env {
    Assistant: DurableObjectNamespace<import("./assistant").Assistant>;

    BRAIN_NAME?: string;
    TIMEZONE?: string;
    BRAIN_HOSTNAME?: string;

    MODEL_BASE_URL: string;
    MODEL_ID: string;
    MODEL_API_KEY: string;
    MODEL_CONTEXT_WINDOW?: string;
    MODEL_MAX_TOKENS?: string;
    MODEL_REASONING?: string;

    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_WEBHOOK_SECRET: string;
    TELEGRAM_CHAT_ID: string;

    BRAIN_TOKEN: string;
    AI: Ai;
    WEB_ALLOWED_HOSTS?: string;
    WEB_BLOCKED_HOSTS?: string;
  }
}
