import { DurableObject } from "cloudflare:workers";

export class Brain extends DurableObject {
  async fetch(): Promise<Response> {
    return new Response("Brain storage moved to D1; this object holds only the archive", {
      status: 410,
    });
  }
}
