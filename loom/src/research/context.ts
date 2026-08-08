import { LIMITS } from "../contract/artifacts.js";

/**
 * Thin typed client for the context.dev API.
 *
 * Every call goes to the same-origin Vite dev proxy at `/api/context/*` (see
 * vite.config.ts), which injects the Authorization header server-side. This file
 * never sees, sends, or logs an API key.
 *
 * Loom uses only *raw* web capabilities. `/web/extract` — the LLM-backed structured
 * extraction endpoint — was removed deliberately: it summarised long list pages no
 * matter how the instructions were worded (one record from a page holding 487), cost
 * ~22s per URL, and produced rows nobody could trace to anything on the page. Raw
 * markdown plus deterministic table parsing is both exhaustive and honest. Do not
 * reintroduce it.
 *
 * Request/response shapes below were confirmed empirically against the live API
 * (curl, with the real key, before this file was written) — not guessed from docs:
 *
 *   POST /web/search   body: { query, numResults, markdownOptions }
 *     -> 200 { results: [{ url, title, description, relevance, markdown }], query, key_metadata }
 *
 *   GET  /web/scrape/markdown?url=<encoded>
 *     -> 200 { success: true, markdown: string }
 *
 *   POST /web/crawl    body: { url, limit }
 *     -> 200 { results: [{ markdown, metadata: { sourceUrl, finalUrl, title, crawlDepth, … } }], metadata, key_metadata }
 *
 *   GET  /web/scrape/images?url=<encoded>
 *     -> 200 { success: true, images: [{ src, element, type, alt }], url, key_metadata }
 *
 *   POST /brand/retrieve   body: { type: "by_domain", domain }
 *     -> 200 { status: "ok", brand: { title, colors: [{hex,name}], logos: [{url,mode,…}], … } }
 */

const BASE = "/api/context/v1";

// Measured: search ~1-2s, markdown 0.6-3.4s, images ~1-2s. Crawl fetches a page per
// unit of `limit`, so it gets a budget that scales rather than one flat number.
const DEFAULT_TIMEOUT_MS = 25_000;
// Search normally answers in 2-6s, but a preflight run measured 96s. Everything
// downstream is gated on discovery — a search that aborts means no research at all,
// not a degraded one — so it gets a budget sized for the tail, not the median.
const SEARCH_TIMEOUT_MS = 60_000;
const CRAWL_TIMEOUT_PER_PAGE_MS = 12_000;
const CRAWL_TIMEOUT_FLOOR_MS = 30_000;

export class ContextApiError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  readonly endpoint: string;
  /** Seconds the API asked us to wait, from `Retry-After` on a 429. */
  readonly retryAfterSeconds?: number;

  constructor(status: number, bodySnippet: string, endpoint: string, retryAfterSeconds?: number) {
    super(`context.dev ${endpoint} failed (status ${status}): ${bodySnippet}`);
    this.name = "ContextApiError";
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.endpoint = endpoint;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function snippet(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function describeUnexpected(json: unknown): string {
  try {
    return snippet(JSON.stringify(json) ?? String(json));
  } catch {
    return "unparseable response body";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Statuses worth a second attempt.
 *
 * 408/5xx are transient by definition and 429 is explicitly "try again later". A
 * 400/401/403/404 is a contract, credential or existence failure — the identical
 * request will fail identically, so retrying only burns the clock during a demo.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 400;
/** However long the API asks us to wait, a demo cannot stall on one page. */
const MAX_RETRY_DELAY_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(res: Response): number | undefined {
  const header = res.headers?.get?.("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Metadata the API returns alongside every call, for cost and quota diagnostics. */
export interface CallMetadata {
  creditsConsumed?: number;
  creditsRemaining?: number;
}

function readMetadata(json: unknown): CallMetadata {
  if (!isRecord(json) || !isRecord(json.key_metadata)) return {};
  const meta = json.key_metadata;
  return {
    creditsConsumed: typeof meta.credits_consumed === "number" ? meta.credits_consumed : undefined,
    creditsRemaining: typeof meta.credits_remaining === "number" ? meta.credits_remaining : undefined,
  };
}

/** The most recent call's quota reading, surfaced by preflight and error paths. */
let lastMetadata: CallMetadata = {};
export function lastCallMetadata(): CallMetadata {
  return lastMetadata;
}

async function requestJson(
  endpoint: string,
  input: { method: "GET" | "POST"; url: string; body?: unknown },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(input.url, {
        method: input.method,
        headers: input.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();

      if (!res.ok) {
        const error = new ContextApiError(res.status, snippet(text), endpoint, parseRetryAfter(res));
        if (attempt < MAX_ATTEMPTS && RETRYABLE_STATUSES.has(res.status)) {
          lastError = error;
          const wait = Math.min(
            error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : RETRY_BASE_DELAY_MS * attempt,
            MAX_RETRY_DELAY_MS,
          );
          await sleep(wait);
          continue;
        }
        throw error;
      }

      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        throw new ContextApiError(res.status, snippet(text), endpoint);
      }
      lastMetadata = readMetadata(json);
      return json;
    } catch (err) {
      // An abort (our own timeout) is transient in exactly the way a 5xx is.
      const isAbort = err instanceof Error && err.name === "AbortError";
      const retryable = isAbort || !(err instanceof ContextApiError);
      if (attempt < MAX_ATTEMPTS && retryable) {
        lastError = err;
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`context.dev ${endpoint} failed`);
}

// ---------------------------------------------------------------------------
// Search — discovery only
// ---------------------------------------------------------------------------

export interface SearchHit {
  url: string;
  title: string;
  description?: string;
  relevance?: string;
}

/**
 * Find real pages for a question.
 *
 * Inline markdown stays off on purpose. Discovery and retrieval are separate steps
 * so the agent picks candidates from titles and descriptions and only *then* spends
 * a retrieval call on the ones it chose — scraping ten pages to read three is the
 * expensive mistake this design exists to avoid.
 */
export async function searchWeb(query: string, numResults = LIMITS.searchResults): Promise<SearchHit[]> {
  const endpoint = "/web/search";
  const json = await requestJson(
    endpoint,
    {
      method: "POST",
      url: `${BASE}${endpoint}`,
      body: {
        query,
        // The API rejects anything below 10.
        numResults: Math.max(LIMITS.searchResults, numResults),
        markdownOptions: { enabled: false },
      },
    },
    SEARCH_TIMEOUT_MS,
  );

  if (!isRecord(json) || !Array.isArray(json.results)) {
    throw new ContextApiError(200, describeUnexpected(json), endpoint);
  }

  const hits: SearchHit[] = [];
  for (const raw of json.results) {
    if (!isRecord(raw)) continue;
    const url = str(raw.url) ?? str(raw.link);
    if (!url) continue;
    hits.push({
      url,
      title: str(raw.title) ?? url,
      description: str(raw.description) ?? str(raw.snippet),
      relevance: str(raw.relevance),
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Raw retrieval
// ---------------------------------------------------------------------------

/** Clean markdown for one URL. */
export async function scrapeMarkdown(url: string): Promise<string> {
  const endpoint = "/web/scrape/markdown";
  const json = await requestJson(endpoint, {
    method: "GET",
    url: `${BASE}${endpoint}?url=${encodeURIComponent(url)}`,
  });
  if (!isRecord(json) || json.success !== true || typeof json.markdown !== "string") {
    throw new ContextApiError(200, describeUnexpected(json), endpoint);
  }
  return json.markdown;
}

export interface CrawledPage {
  url: string;
  title: string;
  markdown: string;
  depth: number;
}

/**
 * Follow a page's links and return each one as markdown.
 *
 * `limit` is clamped here rather than trusted: it is billed per page, and it arrives
 * from a tool call the model wrote.
 */
export async function crawlSite(url: string, limit = LIMITS.defaultCrawlPages): Promise<CrawledPage[]> {
  const endpoint = "/web/crawl";
  const pages = Math.max(1, Math.min(limit, LIMITS.maxCrawlPages));
  const json = await requestJson(
    endpoint,
    { method: "POST", url: `${BASE}${endpoint}`, body: { url, limit: pages } },
    Math.max(CRAWL_TIMEOUT_FLOOR_MS, pages * CRAWL_TIMEOUT_PER_PAGE_MS),
  );

  if (!isRecord(json) || !Array.isArray(json.results)) {
    throw new ContextApiError(200, describeUnexpected(json), endpoint);
  }

  const out: CrawledPage[] = [];
  for (const raw of json.results) {
    if (!isRecord(raw) || typeof raw.markdown !== "string") continue;
    const meta = isRecord(raw.metadata) ? raw.metadata : {};
    const pageUrl = str(meta.finalUrl) ?? str(meta.sourceUrl) ?? str(meta.url) ?? url;
    out.push({
      url: pageUrl,
      title: str(meta.title) ?? pageUrl,
      markdown: raw.markdown,
      depth: typeof meta.crawlDepth === "number" ? meta.crawlDepth : 0,
    });
  }
  return out.slice(0, pages);
}

export interface ScrapedImage {
  src: string;
  alt?: string;
  element?: string;
}

/**
 * Image metadata for one page.
 *
 * A busy page returns hundreds (313 from one Wikipedia article), most of them icons
 * and sprites, so the caller de-duplicates and caps. Nothing is downloaded here —
 * these are URLs the browser will load directly.
 */
export async function scrapeImages(url: string): Promise<ScrapedImage[]> {
  const endpoint = "/web/scrape/images";
  const json = await requestJson(endpoint, {
    method: "GET",
    url: `${BASE}${endpoint}?url=${encodeURIComponent(url)}`,
  });
  if (!isRecord(json) || !Array.isArray(json.images)) {
    throw new ContextApiError(200, describeUnexpected(json), endpoint);
  }

  const out: ScrapedImage[] = [];
  for (const raw of json.images) {
    if (!isRecord(raw)) continue;
    const src = str(raw.src);
    if (!src) continue;
    out.push({ src, alt: str(raw.alt), element: str(raw.element) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brand — decorative enrichment
// ---------------------------------------------------------------------------

export interface BrandInfo {
  name?: string;
  logoUrl?: string;
  color?: string;
}

/** Best-effort brand lookup by domain. */
export async function getBrand(domain: string): Promise<BrandInfo> {
  const endpoint = "/brand/retrieve";
  const json = await requestJson(endpoint, {
    method: "POST",
    url: `${BASE}${endpoint}`,
    body: { type: "by_domain", domain },
  });
  if (!isRecord(json) || json.status !== "ok" || !isRecord(json.brand)) {
    throw new ContextApiError(200, describeUnexpected(json), endpoint);
  }
  const brand = json.brand;

  const name = str(brand.title);

  const logos = Array.isArray(brand.logos) ? brand.logos.filter(isRecord) : [];
  const firstLogo = logos[0];
  const logoUrl = firstLogo ? str(firstLogo.url) : undefined;

  const colors = Array.isArray(brand.colors) ? brand.colors.filter(isRecord) : [];
  const firstColor = colors[0];
  const color = firstColor ? str(firstColor.hex) : undefined;

  return { name, logoUrl, color };
}
