import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { brainExtension, BRAIN_NAME, WHEN_HELP, DEFAULT_TIMEZONE } from "./tools";
import { brainModels, PROVIDER_ID } from "./model";
import { createMemory, SCHEMA, type Memory } from "./store";
import { send } from "./telegram";

const ASK_WAIT_MS = 90_000;
const TURN_WAIT_MS = 240_000;

/** Prefix on the prompt the brain receives when a plan fires. */
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

    const { models, model } = brainModels(this.env);
    this.harness = new PiHarness({
      harness: ({ storage, context }) => Harness.open(storage, { models, registry }, context),
      defaults: { model: { provider: PROVIDER_ID, id: model.id } },
    });
    this.lifecycle.use(this.harness);
  }

  /**
   * One turn in the brain's single conversation; both doors write this same thread. `operationId`
   * makes a redelivered request rejoin the turn instead of asking twice. Returns null when the
   * brain is still running when our patience ends — the turn keeps going and is never lost.
   */
  private async turn(text: string, operationId: string, patienceMs: number): Promise<string | null> {
    const receipt = await this.harness.submit(text, { operationId, whenBusy: "steer" });
    const result = await this.harness.wait(receipt.operationId, { signal: AbortSignal.timeout(patienceMs) });
    return result.status === "done" ? (result.text ?? "(no answer)") : null;
  }

  /** Runs from the webhook's `waitUntil`. The answer is sent once, never edited. */
  async deliverTurn(input: { text: string; operationId: string; chatId: string }): Promise<void> {
    const answer = await this.turn(input.text, input.operationId, TURN_WAIT_MS);
    await send(this.env, input.chatId, answer ?? "Still thinking. Ask again in a moment and it'll be quicker.");
  }

  /** The Agent callback a plan arms. Fires from a Durable Object alarm with nothing of mine running. */
  async planFired(payload: { message: string }): Promise<void> {
    const answer = await this.turn(SCHEDULED_PREFIX + payload.message, `plan${crypto.randomUUID()}`, TURN_WAIT_MS);
    await send(this.env, this.env.TELEGRAM_CHAT_ID, answer ?? `Reminder: ${payload.message}`);
  }

  async ask(question: string): Promise<string> {
    return (
      (await this.turn(question, `ask${crypto.randomUUID()}`, ASK_WAIT_MS)) ??
      "Still working on it — ask again in a moment and the answer will be ready."
    );
  }


  /**
   * Below here is what the terminal door calls. Reads and writes go straight to SQLite: none of these
   * costs an agent turn, which is the whole reason writing a note from the terminal is ~80 tokens.
   */
  async recall(query: string, limit: number): Promise<string> {
    const found = this.memory.search(query, limit);
    return found.total === 0 ? `Nothing stored matching "${query}".` : found.lines.join("\n");
  }

  async remember(items: { text: string; tags?: string }[]): Promise<string> {
    return this.memory.rememberBatch(items, `door${crypto.randomUUID()}`);
  }

  async plan(action: string, input: { message?: string; at?: string; every?: string; id?: string }): Promise<string> {
    if (action === "list") return this.memory.list();
    if (action === "cancel") return this.memory.cancel(input.id ?? "");
    if (!input.message) throw new Error(`add needs a message. ${WHEN_HELP}`);
    return this.memory.add({ id: `door${crypto.randomUUID()}`, message: input.message, at: input.at, every: input.every });
  }

}
