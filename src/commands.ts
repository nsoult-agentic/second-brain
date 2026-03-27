import { getDb, transaction } from "./db.js";
import { createLogger } from "./logger.js";
import { classify, type ClassifyConfig } from "./classifier.js";
import { embed, type EmbeddingConfig } from "./embedding.js";

const log = createLogger("commands");

const VALID_CATEGORIES = ["person", "project", "idea", "task"] as const;
type Category = (typeof VALID_CATEGORIES)[number];
const EXPECTED_DIMENSIONS = 768;

export interface CommandConfig {
  classify: ClassifyConfig;
  ollama: EmbeddingConfig;
}

export interface CommandResult {
  reply: string;
}

function isCategory(s: string): s is Category {
  return VALID_CATEGORIES.includes(s as Category);
}

export function parseCommand(body: string): { name: string; args: string[] } | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  const name = parts[0].slice(1).toLowerCase();
  return { name, args: parts.slice(1) };
}

async function handleApprove(args: string[], config: CommandConfig): Promise<CommandResult> {
  if (args.length < 1) {
    return { reply: "Usage: /approve <capture_id> [category]" };
  }

  const captureId = parseInt(args[0], 10);
  if (!Number.isFinite(captureId) || captureId <= 0) {
    return { reply: `Invalid capture ID: ${args[0]}` };
  }

  const categoryOverride = args[1]?.toLowerCase();
  if (categoryOverride && !isCategory(categoryOverride)) {
    return { reply: `Invalid category: ${categoryOverride}. Valid: ${VALID_CATEGORIES.join(", ")}` };
  }

  const sql = getDb();

  // Find the held inbox_log entry for this capture
  const held = await sql`
    SELECT il.id AS log_id, il.raw_text, il.classified_as, il.confidence,
           c.id AS capture_id, c.processed
    FROM inbox_log il
    JOIN captures c ON c.id = il.capture_id
    WHERE il.capture_id = ${captureId} AND il.held = TRUE AND il.item_id IS NULL
    ORDER BY il.created_at DESC
    LIMIT 1
  `;

  if (held.length === 0) {
    return { reply: `No held item found for capture #${captureId}` };
  }

  const row = held[0];
  const category = (categoryOverride ?? row.classified_as) as Category;
  const rawText = row.raw_text as string;

  // If category override, reclassify to get proper structured data
  let title: string;
  let summary: string;
  let content: string;
  let metadata: Record<string, unknown>;
  let confidence: number;

  if (categoryOverride && categoryOverride !== row.classified_as) {
    // Reclassify with the override hint
    const result = await classify(rawText, config.classify);
    if (result.classification) {
      title = result.classification.title;
      summary = result.classification.summary;
      content = result.classification.content;
      metadata = result.classification.metadata;
      confidence = result.classification.confidence;
    } else {
      // Classification failed — use raw text as fallback
      title = rawText.slice(0, 80);
      summary = "";
      content = rawText;
      metadata = {};
      confidence = row.confidence as number;
    }
  } else {
    // Use the original classification — reclassify to get structured fields
    const result = await classify(rawText, config.classify);
    if (result.classification) {
      title = result.classification.title;
      summary = result.classification.summary;
      content = result.classification.content;
      metadata = result.classification.metadata;
      confidence = result.classification.confidence;
    } else {
      title = rawText.slice(0, 80);
      summary = "";
      content = rawText;
      metadata = {};
      confidence = row.confidence as number;
    }
  }

  // Embed
  const embeddingText = `${title}\n${summary}\n${content}`;
  const embResult = await embed(embeddingText, config.ollama);
  let vecLiteral: string | null = null;
  if (embResult && embResult.dimensions === EXPECTED_DIMENSIONS && embResult.embedding.every((n) => Number.isFinite(n))) {
    vecLiteral = `[${embResult.embedding.join(",")}]`;
  }

  // Store in transaction
  const itemId = await transaction(async (tx) => {
    const itemRows = await tx`
      INSERT INTO items (capture_id, category, confidence, title, summary, content, metadata, embedding)
      VALUES (
        ${captureId},
        ${category},
        ${confidence},
        ${title},
        ${summary},
        ${content},
        ${JSON.stringify(metadata)},
        ${vecLiteral ? tx`${vecLiteral}::vector` : tx`NULL`}
      )
      RETURNING id
    `;
    const newItemId = itemRows[0].id as number;

    // Update inbox_log to link item and unheld
    await tx`
      UPDATE inbox_log SET item_id = ${newItemId}, held = FALSE
      WHERE id = ${row.log_id}
    `;

    // Mark capture processed if not already
    await tx`
      UPDATE captures SET processed = TRUE, processed_at = NOW(), error = NULL
      WHERE id = ${captureId} AND NOT processed
    `;

    return newItemId;
  });

  const overrideNote = categoryOverride && categoryOverride !== row.classified_as
    ? ` (overridden from ${row.classified_as})`
    : "";

  log.info("Approved held capture", { captureId, itemId, category });
  return { reply: `Approved #${captureId} → ${category}: ${title}${overrideNote} (item #${itemId})` };
}

async function handleFix(args: string[]): Promise<CommandResult> {
  if (args.length < 2) {
    return { reply: "Usage: /fix <item_id> <new_category>" };
  }

  const itemId = parseInt(args[0], 10);
  if (!Number.isFinite(itemId) || itemId <= 0) {
    return { reply: `Invalid item ID: ${args[0]}` };
  }

  const newCategory = args[1].toLowerCase();
  if (!isCategory(newCategory)) {
    return { reply: `Invalid category: ${newCategory}. Valid: ${VALID_CATEGORIES.join(", ")}` };
  }

  const sql = getDb();

  const items = await sql`
    SELECT id, category, title FROM items WHERE id = ${itemId}
  `;

  if (items.length === 0) {
    return { reply: `Item #${itemId} not found` };
  }

  const item = items[0];
  const oldCategory = item.category as string;

  if (oldCategory === newCategory) {
    return { reply: `Item #${itemId} is already categorized as ${newCategory}` };
  }

  await transaction(async (tx) => {
    // Update item category
    await tx`
      UPDATE items SET category = ${newCategory} WHERE id = ${itemId}
    `;

    // Log correction in inbox_log
    await tx`
      UPDATE inbox_log
      SET corrected = TRUE, corrected_from = ${oldCategory}, corrected_to = ${newCategory}, corrected_at = NOW()
      WHERE item_id = ${itemId}
    `;
  });

  log.info("Fixed item category", { itemId, from: oldCategory, to: newCategory });
  return { reply: `Fixed #${itemId}: ${oldCategory} → ${newCategory} (${item.title})` };
}

async function handleReject(args: string[]): Promise<CommandResult> {
  if (args.length < 1) {
    return { reply: "Usage: /reject <capture_id>" };
  }

  const captureId = parseInt(args[0], 10);
  if (!Number.isFinite(captureId) || captureId <= 0) {
    return { reply: `Invalid capture ID: ${args[0]}` };
  }

  const sql = getDb();

  // Check it's actually held
  const held = await sql`
    SELECT il.id AS log_id, il.raw_text
    FROM inbox_log il
    WHERE il.capture_id = ${captureId} AND il.held = TRUE AND il.item_id IS NULL
    ORDER BY il.created_at DESC
    LIMIT 1
  `;

  if (held.length === 0) {
    return { reply: `No held item found for capture #${captureId}` };
  }

  await transaction(async (tx) => {
    // Mark capture as rejected
    await tx`
      UPDATE captures SET processed = TRUE, processed_at = NOW(), error = 'rejected'
      WHERE id = ${captureId}
    `;

    // Remove the held log entry (or mark it)
    await tx`
      DELETE FROM inbox_log WHERE id = ${held[0].log_id}
    `;
  });

  const preview = (held[0].raw_text as string).slice(0, 60);
  log.info("Rejected held capture", { captureId });
  return { reply: `Rejected #${captureId}: "${preview}..."` };
}

async function handleStatus(): Promise<CommandResult> {
  const sql = getDb();

  const [pending, heldItems, categoryCounts, totalItems] = await Promise.all([
    sql`SELECT COUNT(*)::int AS count FROM captures WHERE NOT processed AND (error IS NULL OR retry_count < 5)`,
    sql`SELECT COUNT(*)::int AS count FROM inbox_log WHERE held = TRUE AND item_id IS NULL`,
    sql`SELECT category, COUNT(*)::int AS count FROM items GROUP BY category ORDER BY category`,
    sql`SELECT COUNT(*)::int AS count FROM items`,
  ]);

  const pendingCount = pending[0].count;
  const heldCount = heldItems[0].count;
  const total = totalItems[0].count;

  const categories = categoryCounts.map((r) => `  ${r.category}: ${r.count}`).join("\n");

  const lines = [
    `📊 Second Brain Status`,
    ``,
    `Pending captures: ${pendingCount}`,
    `Held for review:  ${heldCount}`,
    `Total items:      ${total}`,
  ];

  if (categoryCounts.length > 0) {
    lines.push(``, `By category:`, categories);
  }

  return { reply: lines.join("\n") };
}

export async function handleCommand(
  body: string,
  config: CommandConfig,
): Promise<CommandResult | null> {
  const cmd = parseCommand(body);
  if (!cmd) return null;

  log.info("Command received", { command: cmd.name, args: cmd.args });

  switch (cmd.name) {
    case "approve":
      return handleApprove(cmd.args, config);
    case "fix":
      return handleFix(cmd.args);
    case "reject":
      return handleReject(cmd.args);
    case "status":
      return handleStatus();
    default:
      return null; // Not a recognized command — treat as capture
  }
}
