import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
} from "@modelcontextprotocol/server";
import { createBrain, maxNoteFrom } from "./brain";
import { brainServer } from "./mcp";
import { Brain } from "./retired-brain";

export { Brain };

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

    const brain = createBrain(env.BRAIN_DB, maxNoteFrom(env));
    const handler = createMcpHandler(() => brainServer(brain, maxNoteFrom(env)), {
      onerror: (error) => console.error("mcp:", error.message),
    });

    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
