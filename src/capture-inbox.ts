import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

const log = createLogger("capture");

export interface CaptureResult {
  id: number;
  capturedAt: string;
  duplicate: boolean;
}

export async function capture(
  rawText: string,
  sourceId?: string,
): Promise<CaptureResult | null> {
  const sql = getDb();

  const rows = await sql`
    INSERT INTO captures (source, source_id, raw_text)
    VALUES ('matrix', ${sourceId ?? null}, ${rawText})
    ON CONFLICT (source, source_id) DO NOTHING
    RETURNING id, captured_at
  `;

  if (rows.length === 0) {
    // Duplicate source_id — already captured
    log.info("Duplicate capture skipped", { sourceId });
    return null;
  }

  const row = rows[0];
  const result: CaptureResult = {
    id: row.id as number,
    capturedAt: String(row.captured_at),
    duplicate: false,
  };

  log.info("Captured", { id: result.id, textLength: rawText.length });
  return result;
}
