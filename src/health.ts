import { createLogger } from "./logger.js";
import * as db from "./db.js";
import * as embedding from "./embedding.js";

const log = createLogger("health");

const startedAt = Date.now();

interface HealthStatus {
  status: "ok" | "degraded" | "down";
  uptime_seconds: number;
  checks: {
    postgres: boolean;
    ollama: boolean;
  };
  last_capture_id: number | null;
  last_capture_at: string | null;
}

let ollamaConfig: embedding.EmbeddingConfig | null = null;

export function setOllamaConfig(config: embedding.EmbeddingConfig): void {
  ollamaConfig = config;
}

async function getLastCapture(): Promise<{
  id: number;
  captured_at: string;
} | null> {
  try {
    const sql = db.getDb();
    const rows = await sql`
      SELECT id, captured_at FROM captures ORDER BY id DESC LIMIT 1
    `;
    if (rows.length === 0) return null;
    return { id: rows[0].id as number, captured_at: String(rows[0].captured_at) };
  } catch {
    return null;
  }
}

async function buildStatus(): Promise<HealthStatus> {
  const pgOk = await db.healthCheck();
  const ollamaOk = ollamaConfig
    ? await embedding.healthCheck(ollamaConfig)
    : false;
  const lastCapture = await getLastCapture();

  const status = pgOk ? (ollamaOk ? "ok" : "degraded") : "down";

  return {
    status,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    checks: {
      postgres: pgOk,
      ollama: ollamaOk,
    },
    last_capture_id: lastCapture?.id ?? null,
    last_capture_at: lastCapture?.captured_at ?? null,
  };
}

export function startHealthServer(port: number): void {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        const status = await buildStatus();
        return new Response(JSON.stringify(status, null, 2), {
          status: status.status === "down" ? 503 : 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  log.info("Health server started", { port, bind: "127.0.0.1" });
}
