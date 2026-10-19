import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";

export const PROVIDER_ID = "brain";

/**
 * Any OpenAI-compatible chat endpoint, declared by env alone.
 *
 * `supportsStore` and `supportsDeveloperRole` stay off because those are the two
 * request fields an endpoint can accept without honouring, and a silently ignored
 * field is a worse debugging session than an absent one.
 */
export function brainModels(env: Env) {
  const required: [string, string | undefined][] = [
    ["MODEL_BASE_URL", env.MODEL_BASE_URL],
    ["MODEL_ID", env.MODEL_ID],
    ["MODEL_API_KEY", env.MODEL_API_KEY],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) throw new Error(`Set these worker vars: ${missing.join(", ")}`);

  const baseUrl = env.MODEL_BASE_URL.replace(/\/$/, "");
  const id = env.MODEL_ID;
  const contextWindow = Number(env.MODEL_CONTEXT_WINDOW ?? 128_000);
  const maxTokens = Number(env.MODEL_MAX_TOKENS ?? 8_192);
  const reasoning = env.MODEL_REASONING === "true";

  const model = {
    id,
    name: id,
    api: "openai-completions" as const,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: { supportsStore: false, supportsDeveloperRole: false },
  };

  const provider = createProvider({
    id: PROVIDER_ID,
    name: new URL(baseUrl).host,
    baseUrl,
    auth: {
      apiKey: {
        name: "Model API key",
        resolve: async () => ({ auth: { apiKey: env.MODEL_API_KEY }, source: "worker secret" }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}
