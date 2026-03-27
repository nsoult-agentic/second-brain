import { createLogger } from "./logger.js";

const log = createLogger("ntfy");

export interface NtfyConfig {
  url: string;
  topic: string;
  token: string;
}

type Priority = 1 | 2 | 3 | 4 | 5;

export async function notify(
  config: NtfyConfig,
  opts: {
    title: string;
    message: string;
    priority?: Priority;
    tags?: string[];
  }
): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      Title: opts.title,
      Priority: String(opts.priority ?? 3),
    };

    if (opts.tags && opts.tags.length > 0) {
      headers.Tags = opts.tags.join(",");
    }

    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    const res = await fetch(`${config.url}/${config.topic}`, {
      method: "POST",
      headers,
      body: opts.message,
    });

    if (!res.ok) {
      log.error("ntfy send failed", { status: res.status });
      return false;
    }

    log.debug("Notification sent", { title: opts.title });
    return true;
  } catch (err) {
    log.error("ntfy error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
