type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: Level = "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function log(
  level: Level,
  module: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    module,
    msg: message,
    ...(metadata && Object.keys(metadata).length > 0 ? metadata : {}),
  };

  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}

export function createLogger(module: string) {
  return {
    debug: (msg: string, meta?: Record<string, unknown>) =>
      log("debug", module, msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) =>
      log("info", module, msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      log("warn", module, msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) =>
      log("error", module, msg, meta),
  };
}
