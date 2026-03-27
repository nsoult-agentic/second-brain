import postgres from "postgres";
import { createLogger } from "./logger.js";

const log = createLogger("db");

let sql: ReturnType<typeof postgres> | null = null;

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function connect(config: DbConfig): ReturnType<typeof postgres> {
  sql = postgres({
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  log.info("Connection pool created", { host: config.host, database: config.database });
  return sql;
}

export function getDb(): ReturnType<typeof postgres> {
  if (!sql) throw new Error("Database not connected. Call connect() first.");
  return sql;
}

export async function healthCheck(): Promise<boolean> {
  if (!sql) return false;
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export type Sql = ReturnType<typeof postgres>;

export async function transaction<T>(
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  if (!sql) throw new Error("Database not connected. Call connect() first.");
  // postgres.js TransactionSql has the same tagged-template call signature as Sql
  // at runtime, but TypeScript's Omit strips it. This wrapper restores the type.
  return sql.begin(fn as any) as Promise<T>;
}

export async function close(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
    log.info("Connection pool closed");
  }
}
