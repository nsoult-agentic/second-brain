import { getDb, transaction } from "./db.js";
import { createLogger } from "./logger.js";
import { classify, type ClassifyConfig } from "./classifier.js";
import { embed, type EmbeddingConfig } from "./embedding.js";
import { notify, type NtfyConfig } from "./ntfy.js";
import { enrichIfUrl } from "./url-fetcher.js";

const log = createLogger("processor");

const POLL_INTERVAL_MS = 5_000;
const CONFIDENCE_THRESHOLD = 0.7;
const BATCH_SIZE = 10;
const MAX_RETRIES = 5;
const EXPECTED_DIMENSIONS = 768;

let running = false;

export interface ProcessorConfig {
  classify: ClassifyConfig;
  ollama: EmbeddingConfig;
  ntfy: NtfyConfig;
}

interface CaptureRow {
  id: number;
  raw_text: string;
  source_id: string | null;
  retry_count: number;
}

async function processOne(
  row: CaptureRow,
  config: ProcessorConfig,
): Promise<"ok" | "retry" | "failed"> {
  const sql = getDb();
  const start = performance.now();

  // 1. Enrich URLs with fetched page content (for better classification)
  const classificationText = await enrichIfUrl(row.raw_text);

  // 2. Classify (using enriched text, but original raw_text is preserved in captures)
  const { classification, retryable, error } = await classify(classificationText, config.classify);

  if (!classification) {
    if (retryable && row.retry_count < MAX_RETRIES - 1) {
      // Transient error — increment retry count, try again later
      await sql`
        UPDATE captures
        SET retry_count = retry_count + 1, error = ${error ?? "transient"}
        WHERE id = ${row.id}
      `;
      log.warn("Transient classification failure, will retry", {
        captureId: row.id,
        retry: row.retry_count + 1,
        maxRetries: MAX_RETRIES,
        error,
      });
      return "retry";
    }

    // Permanent error or max retries exceeded
    await sql`
      UPDATE captures
      SET error = ${error ?? "classification_failed"}, retry_count = retry_count + 1
      WHERE id = ${row.id}
    `;
    log.error("Classification permanently failed", {
      captureId: row.id,
      retries: row.retry_count + 1,
      error,
      retryable,
    });
    return "failed";
  }

  const held = classification.confidence < CONFIDENCE_THRESHOLD;
  const elapsed = Math.round(performance.now() - start);

  if (held) {
    // Low confidence — hold for review (transactional)
    await transaction(async (tx) => {
      await tx`
        INSERT INTO inbox_log (capture_id, raw_text, classified_as, confidence, held, model_used, processing_ms)
        VALUES (${row.id}, ${row.raw_text}, ${classification.category}, ${classification.confidence}, TRUE, ${config.classify.model}, ${elapsed})
      `;
      await tx`
        UPDATE captures SET processed = TRUE, processed_at = NOW(), error = NULL WHERE id = ${row.id}
      `;
    });

    log.info("Held for review", {
      captureId: row.id,
      category: classification.category,
      confidence: classification.confidence,
    });

    const notified = await notify(config.ntfy, {
      title: `Held: ${classification.title}`,
      message: `${classification.category} (${(classification.confidence * 100).toFixed(0)}%) — "${row.raw_text.slice(0, 100)}"`,
      priority: 3,
      tags: ["brain", "held"],
    });
    if (!notified) {
      log.warn("Failed to send ntfy notification for held capture", { captureId: row.id });
    }

    return "ok";
  }

  // 3. Embed
  const embeddingText = `${classification.title}\n${classification.summary}\n${classification.content}`;
  const embResult = await embed(embeddingText, config.ollama);

  // Validate embedding dimensions
  let vecLiteral: string | null = null;
  if (embResult) {
    if (embResult.dimensions !== EXPECTED_DIMENSIONS) {
      log.error("Embedding dimension mismatch", {
        expected: EXPECTED_DIMENSIONS,
        got: embResult.dimensions,
      });
      // Store without embedding rather than failing
    } else if (embResult.embedding.every((n) => Number.isFinite(n))) {
      vecLiteral = `[${embResult.embedding.join(",")}]`;
    } else {
      log.error("Embedding contains non-finite values", { captureId: row.id });
    }
  }

  // 4. Store item + log + mark processed (ALL in one transaction)
  await transaction(async (tx) => {
    const itemRows = await tx`
      INSERT INTO items (capture_id, category, confidence, title, summary, content, metadata, embedding)
      VALUES (
        ${row.id},
        ${classification.category},
        ${classification.confidence},
        ${classification.title},
        ${classification.summary},
        ${classification.content},
        ${JSON.stringify(classification.metadata)},
        ${vecLiteral ? tx`${vecLiteral}::vector` : tx`NULL`}
      )
      RETURNING id
    `;

    const itemId = itemRows[0].id as number;

    await tx`
      INSERT INTO inbox_log (capture_id, raw_text, classified_as, item_id, confidence, held, model_used, processing_ms)
      VALUES (${row.id}, ${row.raw_text}, ${classification.category}, ${itemId}, ${classification.confidence}, FALSE, ${config.classify.model}, ${elapsed})
    `;

    await tx`
      UPDATE captures SET processed = TRUE, processed_at = NOW(), error = NULL WHERE id = ${row.id}
    `;

    log.info("Stored", {
      captureId: row.id,
      itemId,
      category: classification.category,
      confidence: classification.confidence,
      embedded: !!vecLiteral,
      ms: elapsed,
    });
  });

  return "ok";
}

async function pollOnce(config: ProcessorConfig): Promise<{ processed: number; errors: number }> {
  const sql = getDb();

  const rows = (await sql`
    SELECT id, raw_text, source_id, retry_count
    FROM captures
    WHERE NOT processed
      AND (error IS NULL OR retry_count < ${MAX_RETRIES})
    ORDER BY captured_at ASC
    LIMIT ${BATCH_SIZE}
  `) as CaptureRow[];

  if (rows.length === 0) return { processed: 0, errors: 0 };

  log.info("Processing batch", { count: rows.length });

  let errors = 0;
  for (const row of rows) {
    try {
      const result = await processOne(row, config);
      if (result !== "ok") errors++;
    } catch (err) {
      errors++;
      log.error("Unhandled processing error", {
        captureId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await sql`
          UPDATE captures
          SET retry_count = retry_count + 1, error = ${err instanceof Error ? err.message : "unknown"}
          WHERE id = ${row.id}
        `;
      } catch {
        log.error("Failed to update capture error state", { captureId: row.id });
      }
    }
  }

  return { processed: rows.length, errors };
}

export async function startProcessor(config: ProcessorConfig): Promise<void> {
  running = true;
  log.info("Capture processor started", {
    pollInterval: POLL_INTERVAL_MS,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    batchSize: BATCH_SIZE,
    maxRetries: MAX_RETRIES,
  });

  let consecutiveErrorBatches = 0;

  while (running) {
    const { processed, errors } = await pollOnce(config);

    if (processed === 0) {
      consecutiveErrorBatches = 0;
      await Bun.sleep(POLL_INTERVAL_MS);
    } else if (errors === processed) {
      // Entire batch failed — back off to avoid spin-loop
      consecutiveErrorBatches++;
      const backoff = Math.min(POLL_INTERVAL_MS * Math.pow(2, consecutiveErrorBatches), 60_000);
      log.warn("Entire batch failed, backing off", { backoffMs: backoff, consecutiveErrors: consecutiveErrorBatches });
      await Bun.sleep(backoff);
    } else {
      consecutiveErrorBatches = 0;
      // Some succeeded — check for more immediately
    }
  }

  log.info("Capture processor stopped");
}

export function stopProcessor(): void {
  running = false;
}
