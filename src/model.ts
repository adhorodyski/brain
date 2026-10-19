import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";

export const PROVIDER_ID = "callstack";
export const MODEL_ID = "callstack/Apex";

const model = {
  id: MODEL_ID,
  name: MODEL_ID,
  api: "openai-completions" as const,
  provider: PROVIDER_ID,
  baseUrl: "https://api.callstack.ai/v1",
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_144,
  maxTokens: 32_768,
  compat: { supportsStore: false, supportsDeveloperRole: false },
};

export function brainModels(getApiKey: () => string) {
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "Callstack",
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: "Callstack API key",
        resolve: async () => {
          const key = getApiKey();
          if (!key) throw new Error("CALLSTACK_API_KEY is not set");
          return { auth: { apiKey: key }, source: "worker secret" };
        },
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}
