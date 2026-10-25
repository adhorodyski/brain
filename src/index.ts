import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
} from "@modelcontextprotocol/server";
import { Brain, maxNoteFrom } from "./brain";
import { brainServer } from "./mcp";

export { Brain };

const BRAIN_ID = "brain";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/health") {
      return Response.json({ ok: true });
    }

    if (path !== "/mcp") return new Response("not found", { status: 404 });

    if (!(await ctx.access?.getIdentity()))
      return new Response("Access required", { status: 403 });

    const allowed = env.BRAIN_HOSTNAME
      ? [env.BRAIN_HOSTNAME, ...localhostAllowedHostnames()]
      : localhostAllowedHostnames();
    const refused = hostHeaderValidationResponse(request, allowed);
    if (refused) return refused;

    const brain = env.Brain.get(env.Brain.idFromName(BRAIN_ID));
    const handler = createMcpHandler(() => brainServer(brain, maxNoteFrom(env)), {
      onerror: (error) => console.error("mcp:", error.message),
    });

    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
