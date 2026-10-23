import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  OAuthError,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { Brain } from "./brain";
import { brainServer } from "./mcp";
import type { Principal } from "./store";

export { Brain };

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const BRAIN_ID = "brain";

const ownerOf = (tokens: string | undefined, token: string): string | undefined =>
  tokens
    ?.split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => [pair.slice(0, pair.lastIndexOf("=")), pair.slice(pair.lastIndexOf("=") + 1)] as const)
    .find(([value]) => value.length > 0 && value === token)?.[1] ?? undefined;

const principalOf = (auth: AuthInfo): Principal => ({
  owner: String(auth.extra?.owner ?? ""),
  source: auth.clientId,
});

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/health") {
      return Response.json({ ok: true });
    }

    if (path !== "/mcp") return new Response("not found", { status: 404 });

    const allowed = env.BRAIN_HOSTNAME
      ? [env.BRAIN_HOSTNAME, ...localhostAllowedHostnames()]
      : localhostAllowedHostnames();
    const refused = hostHeaderValidationResponse(request, allowed);
    if (refused) return refused;

    const gate = requireBearerAuth({
      verifier: {
        verifyAccessToken: async (token) => {
          const owner = ownerOf(env.BRAIN_TOKENS, token);
          if (!owner) throw new OAuthError("invalid_token", "unknown token");
          return {
            token,
            clientId: owner,
            scopes: ["brain"],
            expiresAt: Math.floor(Date.now() / 1000) + YEAR_SECONDS,
            extra: { owner },
          };
        },
      },
    });

    const auth = await gate(request);
    if (auth instanceof Response) return auth;

    const principal = principalOf(auth);
    const brain = env.Brain.get(env.Brain.idFromName(BRAIN_ID));
    const handler = createMcpHandler(() => brainServer(brain, principal), {
      onerror: (error) => console.error("mcp:", error.message),
    });

    try {
      return await handler.fetch(request, { authInfo: auth });
    } catch (error) {
      if (error instanceof OAuthError) return bearerAuthChallengeResponse(error);
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
