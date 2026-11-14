import { fileURLToPath } from "node:url";
import { YumiClient } from "./client.js";

/** <project root>/.yumi-session.json — same for src/ (tsx) and dist/ (built). */
const DEFAULT_SESSION_FILE = fileURLToPath(new URL("../../.yumi-session.json", import.meta.url));

export * from "./client.js";
export * from "./http.js";
export * from "./orders.js";
export * from "./types.js";

/** Client configured from environment variables (shared by the REST API and the MCP server). */
export function createClientFromEnv(env: NodeJS.ProcessEnv = process.env): YumiClient {
  return new YumiClient({
    baseUrl: env.YUMI_BASE_URL,
    sessionFile: env.YUMI_SESSION_FILE ?? DEFAULT_SESSION_FILE,
    initialCookies: env.YUMI_COOKIE,
    minIntervalMs: env.YUMI_MIN_INTERVAL_MS ? Number(env.YUMI_MIN_INTERVAL_MS) : undefined,
  });
}
