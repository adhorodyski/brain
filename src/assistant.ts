import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { brainExtension, BRAIN_NAME, WHEN_HELP, DEFAULT_TIMEZONE } from "./tools";
import { brainWebTool } from "./web";
import { brainModels, PROVIDER_ID } from "./model";
import { createMemory, SCHEMA, type Memory } from "./store";
import { send } from "./telegram";

const ASK_BUDGET_MS = 90_000;
const TURN_BUDGET_MS = 240_000;

export const SCHEDULED_PREFIX = "A plan of mine just came due. Tell me about it, then act on it if it says to: ";

export class Assistant extends Agent<Env> {
  private harness: PiHarness;
  private memory: Memory;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    for (const statement of SCHEMA) this.ctx.storage.sql.exec(statement);

    this.memory = createMemory({
      sql: (statement, values) => Array.from(this.ctx.storage.sql.exec(statement, ...(values ?? []))),
      arm: (when, payload) => this.schedule(when, "planFired", payload, { idempotent: true }),
      disarm: (scheduleId) => this.cancelSchedule(scheduleId),
    });

    const registry = createRegistry();
    registry.install(brainExtension(this.memory, { who: BRAIN_NAME(this.env), zone: this.env.TIMEZONE ?? DEFAULT_TIMEZONE }));
    registry.install({ name: "web", tools: [brainWebTool(this.env)] });

    const { models, model } = brainModels(this.env);
    this.harness = new PiHarness({
      harness: ({ storage, context }) => Harness.open(storage, { models, registry }, context),
      defaults: { model: { provider: PROVIDER_ID, id: model.id } },
    });
    this.lifecycle.use(this.harness);
  }

  private async turnWithin(text: string, operationId: string, budgetMs: number): Promise<string | null> {
    const receipt = await this.harness.submit(text, { operationId, whenBusy: "steer" });
    const result = await this.harness.wait(receipt.operationId, { signal: AbortSignal.timeout(budgetMs) });
    return result.status === "done" ? (result.text ?? "(no answer)") : null;
  }

  async deliverTurn(input: { text: string; operationId: string; chatId: string }): Promise<void> {
    const answer = await this.turnWithin(input.text, input.operationId, TURN_BUDGET_MS);
    await send(this.env, input.chatId, answer ?? "Still thinking. Ask again in a moment and it'll be quicker.");
  }

  async planFired(payload: { message: string }): Promise<void> {
    const answer = await this.turnWithin(SCHEDULED_PREFIX + payload.message, `plan${crypto.randomUUID()}`, TURN_BUDGET_MS);
    await send(this.env, this.env.TELEGRAM_CHAT_ID, answer ?? `Reminder: ${payload.message}`);
  }

  async ask(question: string): Promise<string> {
    return (
      (await this.turnWithin(question, `ask${crypto.randomUUID()}`, ASK_BUDGET_MS)) ??
      "Still working on it — ask again in a moment and the answer will be ready."
    );
  }

  async recall(query: string, limit: number): Promise<string> {
    const found = this.memory.search(query, limit);
    return found.total === 0 ? `Nothing stored matching "${query}".` : found.lines.join("\n");
  }

  async remember(items: { text: string; tags?: string }[]): Promise<string> {
    return this.memory.rememberBatch(items, `door${crypto.randomUUID()}`);
  }

  async forget(noteId: number, confirm: string): Promise<string> {
    return this.memory.forget(noteId, confirm);
  }

  async plan(action: string, input: { message?: string; at?: string; every?: string; id?: string }): Promise<string> {
    if (action === "list") return this.memory.list();
    if (action === "cancel") {
      if (!input.id) throw new Error("cancel needs an id from list.");
      return this.memory.cancel(input.id);
    }
    if (!input.message) throw new Error(`add needs a message. ${WHEN_HELP}`);
    return this.memory.add({ id: `door${crypto.randomUUID()}`, message: input.message, at: input.at, every: input.every });
  }
}
