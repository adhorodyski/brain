import { spawn } from "node:child_process";

const BOOT_TIMEOUT_MS = 90_000;

export function startDevServer(port, stateDir) {
  if (process.versions.bun) {
    console.error("run these tools with node: wrangler dev cannot forward requests under bun (bun#39247)");
    process.exit(1);
  }
  const cli = new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, "dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", stateDir, "--log-level", "none"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
  });
  child.on("error", (error) => {
    console.error(`wrangler failed to start: ${error.message}`);
    process.exit(1);
  });
  return { child, ready: waitForHealth(port) };
}

async function waitForHealth(port) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const reply = await fetch(`http://127.0.0.1:${port}/health`);
      if (reply.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the dev server never answered /health within ${BOOT_TIMEOUT_MS / 1000}s`);
}
