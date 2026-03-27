import { createLogger } from "./logger.js";

const log = createLogger("embedding");

export interface EmbeddingConfig {
  url: string;
  model: string;
  timeout: number;
}

export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
}

export async function embed(
  text: string,
  config: EmbeddingConfig
): Promise<EmbeddingResult | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout);

    const res = await fetch(`${config.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, input: text }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      log.error("Ollama returned error", { status: res.status });
      return null;
    }

    const data = (await res.json()) as { embeddings: number[][] };
    const vec = data.embeddings?.[0];
    if (!vec || vec.length === 0) {
      log.error("Empty embedding returned");
      return null;
    }

    log.debug("Embedding generated", { dimensions: vec.length, textLength: text.length });
    return { embedding: vec, dimensions: vec.length };
  } catch (err) {
    log.error("Embedding failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function healthCheck(config: EmbeddingConfig): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${config.url}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
