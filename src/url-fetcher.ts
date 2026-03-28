import { createLogger } from "./logger.js";
import { resolve } from "dns/promises";

const log = createLogger("url-fetcher");

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_CHARS = 500;
const MAX_BODY_BYTES = 1_048_576; // 1 MB — stream cap to prevent OOM

/**
 * Returns true if an IP address is in a private/reserved range.
 * Blocks: loopback, RFC1918, link-local, cloud metadata, IPv6 equivalents.
 */
function isPrivateIp(ip: string): boolean {
  // IPv4
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip === "0.0.0.0") return true;
  if (ip.startsWith("169.254.")) return true; // link-local + cloud metadata
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // IPv6
  if (ip === "::1" || ip === "::") return true;
  if (ip.toLowerCase().startsWith("fe80:")) return true; // link-local
  if (ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd")) return true; // ULA
  return false;
}

/**
 * Resolve hostname and check all resulting IPs are public.
 * Returns true if safe to fetch, false if any IP is private.
 */
async function isSafeUrl(urlStr: string): Promise<boolean> {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;

    // Direct IP check
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
      return !isPrivateIp(hostname);
    }

    // DNS resolution
    const addresses = await resolve(hostname);
    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        log.warn("Blocked private IP in DNS resolution", { hostname, ip: addr });
        return false;
      }
    }
    return addresses.length > 0;
  } catch {
    return false; // DNS failure = don't fetch
  }
}

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
 * Read response body up to MAX_BODY_BYTES. Prevents OOM from multi-GB responses.
 */
async function readBounded(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        chunks.push(value.slice(0, value.byteLength - (totalBytes - MAX_BODY_BYTES)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
}

/**
 * Build enriched text from fetched HTML for classification.
 */
function buildEnriched(rawText: string, url: string, html: string): string {
  const title = extractTitle(html);
  const description = extractDescription(html);
  const bodyText = extractBodyText(html);

  const parts: string[] = [`[URL] ${rawText.trim()}`];
  if (title) parts.push(`[Title] ${title}`);
  if (description) parts.push(`[Description] ${description}`);
  if (bodyText) parts.push(`[Content] ${bodyText}`);

  log.info("URL enriched for classification", {
    url,
    titleLength: title.length,
    descLength: description.length,
    bodyLength: bodyText.length,
  });

  return parts.join("\n");
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
    // SSRF protection: resolve hostname and block private/internal IPs
    if (!(await isSafeUrl(url))) {
      log.warn("Blocked URL targeting private/internal IP", { url });
      return rawText;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "manual", // Handle redirects manually to check each hop
      headers: {
        "User-Agent": "SecondBrain/1.0 (URL preview fetcher)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });

    clearTimeout(timer);

    // Handle redirects manually — check each target for SSRF
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        const redirectUrl = new URL(location, url).toString();
        if (!(await isSafeUrl(redirectUrl))) {
          log.warn("Blocked redirect to private/internal IP", { url, redirect: redirectUrl });
          return rawText;
        }
        // Fetch the redirect target (single hop — no chaining)
        const controller2 = new AbortController();
        const timer2 = setTimeout(() => controller2.abort(), FETCH_TIMEOUT_MS);
        const res2 = await fetch(redirectUrl, {
          signal: controller2.signal,
          redirect: "manual",
          headers: {
            "User-Agent": "SecondBrain/1.0 (URL preview fetcher)",
            Accept: "text/html,application/xhtml+xml,*/*",
          },
        });
        clearTimeout(timer2);
        if (!res2.ok) {
          log.warn("Redirect target failed", { url: redirectUrl, status: res2.status });
          return rawText;
        }
        const ct = res2.headers.get("content-type") ?? "";
        if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return rawText;
        const html = await readBounded(res2);
        return buildEnriched(rawText, url, html);
      }
      return rawText;
    }

    if (!res.ok) {
      log.warn("URL fetch failed with status", { url, status: res.status });
      return rawText;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      log.info("Non-HTML content type, skipping enrichment", { url, contentType });
      return rawText;
    }

    // Bounded read: stream up to MAX_BODY_BYTES to prevent OOM
    const html = await readBounded(res);

    return buildEnriched(rawText, url, html);
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
