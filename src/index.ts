import { loadConfig } from "./config.js";
import { setLogLevel } from "./logger.js";
import { createLogger } from "./logger.js";
import * as db from "./db.js";
import * as matrix from "./matrix-client.js";
import { capture } from "./capture-inbox.js";
import { handleCommand } from "./commands.js";
import { startProcessor, stopProcessor } from "./capture-processor.js";
import { startHealthServer, setOllamaConfig } from "./health.js";

const log = createLogger("main");

async function main(): Promise<void> {
  log.info("Second Brain Capture starting");

  // Load config
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // Connect to PostgreSQL
  db.connect(config.db);
  const pgOk = await db.healthCheck();
  if (!pgOk) {
    log.error("PostgreSQL connection failed — exiting");
    process.exit(1);
  }
  log.info("PostgreSQL connected");

  // Start health server
  setOllamaConfig(config.ollama);
  startHealthServer(config.healthPort);

  // Command config for /approve (needs classify + embedding)
  const commandConfig = { classify: config.classify, ollama: config.ollama };

  // Handle incoming messages — commands first, then capture
  matrix.onMessage(async (event) => {
    // Try command first
    if (event.body.startsWith("/")) {
      const cmdResult = await handleCommand(event.body, commandConfig);
      if (cmdResult) {
        await matrix.sendMessage(cmdResult.reply);
        return;
      }
      // Unrecognized command — fall through to capture
    }

    const result = await capture(event.body, event.eventId);
    if (result) {
      await matrix.sendMessage(`Captured (#${result.id})`);
    }
    // null = duplicate, silently skip
  });

  // Start capture processor (runs in background)
  startProcessor({
    classify: config.classify,
    ollama: config.ollama,
    ntfy: config.ntfy,
  }).catch((err) => {
    log.error("Processor crashed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down");
    matrix.stop();
    stopProcessor();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Start Matrix sync loop (blocks)
  await matrix.start(config.matrix);
}

main().catch((err) => {
  log.error("Fatal error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
