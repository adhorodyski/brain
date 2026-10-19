import { getAgentByName } from "agents";
import { Assistant } from "./assistant";
import { door, mountFor } from "./door";
import { BRAIN } from "./tools";

export { Assistant };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/health") return Response.json({ brain: BRAIN });

    if (path === "/telegram/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }

      const update = (await request.json().catch(() => undefined)) as
        | { update_id: number; message?: { chat?: { id?: number }; text?: string } }
        | undefined;
      const text = update?.message?.text?.trim();
      const chatId = String(update?.message?.chat?.id ?? "");

      // Answer 200 immediately: Telegram retries a webhook that stays silent, and a brain turn
      // takes far longer than a webhook should. The queue is durable, so the reply still gets
      // sent if this object is evicted while the brain is thinking.
      if (text && chatId === env.TELEGRAM_CHAT_ID) {
        const brain = await getAgentByName(env.Assistant, BRAIN);
        await brain.queue("deliverTurn", { text, chatId, operationId: `tg${update!.update_id}` });
      }
      return new Response("ok");
    }

    if (path === "/mcp") {
      if (!mountFor(request, env)) return new Response("unauthorized", { status: 401 });
      return door(env)(request, env, ctx);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
