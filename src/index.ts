import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  OAuthError,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { Brain } from "./brain";
import { brainServer } from "./mcp";

export { Brain };

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const BRAIN_ID = "brain";

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
          if (!env.BRAIN_TOKEN || token !== env.BRAIN_TOKEN)
            throw new OAuthError("invalid_token", "unknown token");
          return {
            token,
            clientId: "brain",
            scopes: ["brain"],
            expiresAt: Math.floor(Date.now() / 1000) + YEAR_SECONDS,
          };
        },
      },
    });

    const auth = await gate(request);
    if (auth instanceof Response) return auth;

    const brain = env.Brain.get(env.Brain.idFromName(BRAIN_ID));
    const handler = createMcpHandler(() => brainServer(brain), {
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
