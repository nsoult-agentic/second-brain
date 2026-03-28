import { createLogger } from "./logger.js";

const log = createLogger("matrix");

export interface MatrixConfig {
  homeserver: string;
  accessToken: string;
  userId: string;
  roomId: string;
}

export interface MatrixEvent {
  eventId: string;
  sender: string;
  body: string;
  timestamp: number;
}

type MessageHandler = (event: MatrixEvent) => void | Promise<void>;

// Sender allowlist: if set, only these Matrix user IDs can interact
const ALLOWED_SENDERS: Set<string> | null = (() => {
  const raw = process.env["ALLOWED_SENDERS"] ?? "";
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
})();

// Rate limiter: max messages per sender per window
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

// Dedup cache: circular buffer of recent event IDs
const DEDUP_SIZE = 500;
const seenEvents = new Set<string>();
const seenQueue: string[] = [];

// Backoff state
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
let backoffMs = MIN_BACKOFF_MS;

// Sync state
let nextBatch: string | undefined;
let running = false;
let handler: MessageHandler | null = null;
let config: MatrixConfig | null = null;

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config!.accessToken}`,
    "Content-Type": "application/json",
  };
}

function isDuplicate(eventId: string): boolean {
  if (seenEvents.has(eventId)) return true;
  seenEvents.add(eventId);
  seenQueue.push(eventId);
  if (seenQueue.length > DEDUP_SIZE) {
    const old = seenQueue.shift()!;
    seenEvents.delete(old);
  }
  return false;
}

function isRateLimited(sender: string): boolean {
  const now = Date.now();
  let timestamps = rateBuckets.get(sender);
  if (!timestamps) {
    timestamps = [];
    rateBuckets.set(sender, timestamps);
  }
  // Prune old entries
  while (timestamps.length > 0 && timestamps[0] < now - RATE_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_LIMIT) return true;
  timestamps.push(now);
  return false;
}

function buildSyncFilter(roomId: string): string {
  return JSON.stringify({
    room: {
      rooms: [roomId],
      timeline: { limit: 20 },
      state: { lazy_load_members: true },
    },
    presence: { types: [] },
    account_data: { types: [] },
  });
}

async function doSync(): Promise<void> {
  const params = new URLSearchParams({
    timeout: "30000",
    filter: buildSyncFilter(config!.roomId),
  });
  if (nextBatch) {
    params.set("since", nextBatch);
  }

  const url = `${config!.homeserver}/_matrix/client/v3/sync?${params}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);

  try {
    const res = await fetch(url, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Sync failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as {
      next_batch: string;
      rooms?: {
        join?: Record<
          string,
          {
            timeline?: {
              events?: Array<{
                event_id: string;
                type: string;
                sender: string;
                content: { msgtype?: string; body?: string };
                origin_server_ts: number;
              }>;
            };
          }
        >;
      };
    };

    nextBatch = data.next_batch;

    // On first sync, just record the batch token — don't process old messages
    if (!nextBatch) return;

    const roomData = data.rooms?.join?.[config!.roomId];
    const events = roomData?.timeline?.events ?? [];

    for (const ev of events) {
      if (ev.type !== "m.room.message") continue;
      if (ev.content.msgtype !== "m.text") continue;
      if (ev.sender === config!.userId) continue; // Ignore own messages
      if (ALLOWED_SENDERS && !ALLOWED_SENDERS.has(ev.sender)) {
        log.warn("Blocked unauthorized sender", { sender: ev.sender });
        continue;
      }
      if (isDuplicate(ev.event_id)) continue;
      if (isRateLimited(ev.sender)) {
        log.warn("Rate limited", { sender: ev.sender });
        continue;
      }

      const matrixEvent: MatrixEvent = {
        eventId: ev.event_id,
        sender: ev.sender,
        body: ev.content.body ?? "",
        timestamp: ev.origin_server_ts,
      };

      if (handler) {
        try {
          await handler(matrixEvent);
        } catch (err) {
          log.error("Handler error", {
            eventId: ev.event_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Reset backoff on success
    backoffMs = MIN_BACKOFF_MS;
  } catch (err) {
    clearTimeout(timer);
    log.error("Sync error", {
      error: err instanceof Error ? err.message : String(err),
      backoffMs,
    });
    await Bun.sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

export async function sendMessage(body: string): Promise<string | null> {
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const url = `${config!.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(config!.roomId)}/send/m.room.message/${txnId}`;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        msgtype: "m.text",
        body,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error("Send failed", { status: res.status, body: text });
      return null;
    }

    const data = (await res.json()) as { event_id: string };
    log.debug("Message sent", { eventId: data.event_id });
    return data.event_id;
  } catch (err) {
    log.error("Send error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function onMessage(fn: MessageHandler): void {
  handler = fn;
}

export async function start(cfg: MatrixConfig): Promise<void> {
  config = cfg;
  running = true;

  log.info("Starting Matrix client", {
    homeserver: cfg.homeserver,
    userId: cfg.userId,
    roomId: cfg.roomId,
  });

  // Initial sync to get batch token (don't process old messages)
  await doSync();
  log.info("Initial sync complete, listening for messages");

  // Long-poll loop
  while (running) {
    await doSync();
  }
}

export function stop(): void {
  running = false;
  log.info("Matrix client stopping");
}
