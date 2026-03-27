import { readFileSync } from "fs";

export interface Config {
  // PostgreSQL
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };

  // Matrix
  matrix: {
    homeserver: string;
    accessToken: string;
    userId: string;
    roomId: string;
  };

  // Ollama embedding
  ollama: {
    url: string;
    model: string;
    timeout: number;
  };

  // Ollama classification
  classify: {
    url: string;
    model: string;
    timeout: number;
  };

  // ntfy
  ntfy: {
    url: string;
    topic: string;
    token: string;
  };

  // Service
  healthPort: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

function loadSecretFile<T>(path: string): T {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content) as T;
}

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env var: ${key}`);
  return val;
}

/** Read secret from file path (Docker secrets pattern: KEY_FILE env var) */
function envOrFile(key: string, fallback?: string): string {
  // Check for direct env var first
  const direct = process.env[key];
  if (direct) return direct;
  // Check for _FILE variant
  const filePath = process.env[`${key}_FILE`];
  if (filePath) {
    return readFileSync(filePath, "utf-8").trim();
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env var: ${key} (or ${key}_FILE)`);
}

export function loadConfig(): Config {
  const matrixSecretPath = env("MATRIX_SECRET_FILE");

  const matrix = loadSecretFile<Config["matrix"]>(matrixSecretPath);

  return {
    db: {
      host: env("DB_HOST", "127.0.0.1"),
      port: parseInt(env("DB_PORT", "5432"), 10),
      database: env("DB_NAME", "second_brain"),
      user: env("DB_USER", "pai"),
      password: envOrFile("DB_PASSWORD"),
    },

    matrix,

    classify: {
      url: env("OLLAMA_URL"),
      model: env("OLLAMA_CLASSIFY_MODEL", "hermes3:8b"),
      timeout: parseInt(env("OLLAMA_CLASSIFY_TIMEOUT", "60000"), 10),
    },

    ollama: {
      url: env("OLLAMA_URL"),
      model: env("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
      timeout: parseInt(env("OLLAMA_TIMEOUT", "30000"), 10),
    },

    ntfy: {
      url: env("NTFY_URL"),
      topic: env("NTFY_TOPIC", "second-brain"),
      token: envOrFile("NTFY_TOKEN", ""),
    },

    healthPort: parseInt(env("HEALTH_PORT", "9098"), 10),
    logLevel: env("LOG_LEVEL", "info") as Config["logLevel"],
  };
}
