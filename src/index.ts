import { getAgentByName } from "agents";
import { Assistant } from "./assistant";
import { door, isTrusted } from "./door";
import { BRAIN_NAME } from "./tools";

export { Assistant };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/health") return Response.json({ brain: BRAIN_NAME(env) });

    if (path === "/telegram/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }

      const update = (await request.json().catch(() => undefined)) as
        | { update_id: number; message?: { chat?: { id?: number }; text?: string } }
        | undefined;
      const text = update?.message?.text?.trim();
      const chatId = String(update?.message?.chat?.id ?? "");

      if (text && chatId !== env.TELEGRAM_CHAT_ID) {
        console.warn(`telegram: dropped message from chat ${chatId}, TELEGRAM_CHAT_ID is ${env.TELEGRAM_CHAT_ID ?? "unset"}`);
        return new Response("ok");
      }

      // Telegram retries a webhook that stays silent, well before a brain turn finishes.
      if (text) {
        const brain = await getAgentByName(env.Assistant, BRAIN_NAME(env));
        await brain.queue("deliverTurn", { text, chatId, operationId: `tg${update!.update_id}` });
      }
      return new Response("ok");
    }

    if (path === "/mcp") {
      if (!isTrusted(request, env)) return new Response("unauthorized", { status: 401 });
      return door(env)(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
