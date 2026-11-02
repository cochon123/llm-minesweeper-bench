import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Path to a checkout of https://github.com/cochon123/cli2api (defaults to a sibling folder).
const CLI2API_ROOT = process.env.CLI2API_ROOT || path.resolve(__dirname, "..", "cli2api");
export const GATEWAY_PORT = Number(process.env.CLI2API_PORT || 3927);
export const GATEWAY_TOKEN = process.env.CLI2API_TOKEN || "minesweeper-local";
export const SANDBOX = process.env.CLI2API_CWD || "/tmp/ai-ms-sandbox";

function waitPort(port, host = "127.0.0.1", timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = createConnection({ port, host }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`cli2api did not open ${host}:${port}`));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

export async function ensureGateway() {
  await mkdir(SANDBOX, { recursive: true });
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${GATEWAY_PORT}/v1`;
  process.env.OPENAI_API_KEY = GATEWAY_TOKEN;
  process.env.CLI2API_TOKEN = GATEWAY_TOKEN;
  try {
    await waitPort(GATEWAY_PORT, "127.0.0.1", 400);
    return { started: false, port: GATEWAY_PORT, token: GATEWAY_TOKEN };
  } catch {
    // not up
  }
  const child = spawn(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "serve",
      "--port", String(GATEWAY_PORT),
      "--token", GATEWAY_TOKEN,
      "--cwd", SANDBOX,
      "--cursor-bin", path.join(__dirname, "cursor-agent-nosandbox"),
    ],
    {
      cwd: CLI2API_ROOT,
      env: {
        ...process.env,
        CLI2API_TOKEN: GATEWAY_TOKEN,
        CLI2API_CWD: SANDBOX,
      },
      stdio: "ignore",
      detached: true,
    },
  );
  child.unref();
  try {
    await waitPort(GATEWAY_PORT, "127.0.0.1", 25_000);
  } catch (error) {
    throw new Error(`${error.message} (cli2api did not become ready)`);
  }
  return { started: true, port: GATEWAY_PORT, token: GATEWAY_TOKEN, pid: child.pid };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const info = await ensureGateway();
  console.log(JSON.stringify(info, null, 2));
}
