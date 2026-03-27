import { createLogger } from "./logger.js";

const log = createLogger("url-fetcher");

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_CHARS = 500;

/**
 * Detect whether raw_text looks like a URL.
 * Matches:
 *  - Strings starting with http:// or https://
 *  - Bare domains like github.com/foo/bar (no whitespace, has at least one dot before a slash or end)
 */
function isUrl(text: string): boolean {
  const trimmed = text.trim();
  // Must be a single token (no spaces/newlines) to be treated as a bare URL
  if (/\s/.test(trimmed)) return false;
  // Explicit protocol
  if (/^https?:\/\//i.test(trimmed)) return true;
  // Bare domain: word.tld/... pattern
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+([/?#]|$)/i.test(trimmed)) return true;
  return false;
}

/**
 * Strip HTML tags from a string, collapse whitespace, and trim.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the page title from HTML.
 */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).slice(0, 200) : "";
}

/**
 * Extract meta description from HTML.
 */
function extractDescription(html: string): string {
  // Try og:description first, then standard meta description
  const ogMatch = html.match(
    /<meta[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["'][^>]*\/?>/i,
  );
  if (ogMatch) return stripHtml(ogMatch[1]).slice(0, 500);

  // Also check reverse attribute order (content before property)
  const ogMatchReverse = html.match(
    /<meta[^>]*content=["']([\s\S]*?)["'][^>]*property=["']og:description["'][^>]*\/?>/i,
  );
  if (ogMatchReverse) return stripHtml(ogMatchReverse[1]).slice(0, 500);

  const descMatch = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*\/?>/i,
  );
  if (descMatch) return stripHtml(descMatch[1]).slice(0, 500);

  // Reverse attribute order for standard description too
  const descMatchReverse = html.match(
    /<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*\/?>/i,
  );
  if (descMatchReverse) return stripHtml(descMatchReverse[1]).slice(0, 500);

  return "";
}

/**
 * Extract body text from HTML (first N characters after stripping tags).
 */
function extractBodyText(html: string): string {
  // Remove head section entirely to avoid meta noise
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const text = stripHtml(bodyHtml);
  return text.slice(0, MAX_BODY_CHARS);
}

/**
 * Normalize raw_text into a fetchable URL.
 * Adds https:// to bare domains.
 */
function normalizeUrl(text: string): string {
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * If raw_text is a URL, fetch the page and return enriched text for classification.
 * If not a URL or if fetching fails, returns the original raw_text unchanged.
 */
export async function enrichIfUrl(rawText: string): Promise<string> {
  if (!isUrl(rawText)) {
    return rawText;
  }

  const url = normalizeUrl(rawText);
  log.info("Fetching URL for enrichment", { url });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "SecondBrain/1.0 (URL preview fetcher)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      // @ts-expect-error -- Bun fetch supports maxRedirections
      maxRedirections: MAX_REDIRECTS,
    });

    clearTimeout(timer);

    if (!res.ok) {
      log.warn("URL fetch failed with status", { url, status: res.status });
      return rawText;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      log.info("Non-HTML content type, skipping enrichment", { url, contentType });
      return rawText;
    }

    const html = await res.text();

    const title = extractTitle(html);
    const description = extractDescription(html);
    const bodyText = extractBodyText(html);

    // Build enriched text only with non-empty parts
    const parts: string[] = [`[URL] ${rawText.trim()}`];
    if (title) parts.push(`[Title] ${title}`);
    if (description) parts.push(`[Description] ${description}`);
    if (bodyText) parts.push(`[Content] ${bodyText}`);

    const enriched = parts.join("\n");

    log.info("URL enriched for classification", {
      url,
      titleLength: title.length,
      descLength: description.length,
      bodyLength: bodyText.length,
    });

    return enriched;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === "AbortError";
    log.warn("URL fetch failed, using original text", {
      url,
      error: message,
      timeout: isAbort,
    });
    return rawText;
  }
}

// Export internals for testing
export { isUrl, stripHtml, extractTitle, extractDescription, extractBodyText, normalizeUrl };
