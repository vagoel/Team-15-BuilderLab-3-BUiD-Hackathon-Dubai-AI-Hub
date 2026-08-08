import { scrapeMarkdown } from "./context.js";

/**
 * In-memory warm cache, mirrored into sessionStorage so a page reload stays warm.
 *
 * This is the whole difference between a good demo and a dead one: 3.39s cold vs
 * 0.90s warm per PLAN.md §7. Keyed by request (caller decides the key shape),
 * TTL'd at 30 minutes.
 */

interface CacheEntry<T> {
  value: T;
  ts: number;
}

export const DEFAULT_TTL_MS = 30 * 60 * 1000;

// Bump this whenever a cached value's shape changes. sessionStorage survives a page
// reload within the same tab, so without a version tag a stale entry written by an
// older build (different Dataset/DataRecord shape, different error format) would be
// read back as if it were valid — `ts` is the only field ever validated on the way
// in, so a shape-mismatched `.value` would sail through and corrupt whatever reads
// it. Bumping this string is a cheap, total invalidation.
const SESSION_VERSION = "v2";
// Exported so tests can target the real prefix instead of a hardcoded duplicate that
// would silently drift out of sync with a future version bump. Not part of the
// public research-engine API (see index.ts) — this module's internals stay free to
// change shape, same as context.ts and pipeline.ts's non-exported pieces.
export const SESSION_PREFIX = `loom:cache:${SESSION_VERSION}:`;

const mem = new Map<string, CacheEntry<unknown>>();

function readSession<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (typeof parsed?.ts !== "number") return null;
    return parsed;
  } catch {
    // sessionStorage unavailable (SSR/tests) or entry corrupt — treat as a miss.
    return null;
  }
}

function writeSession<T>(key: string, entry: CacheEntry<T>): void {
  try {
    sessionStorage.setItem(SESSION_PREFIX + key, JSON.stringify(entry));
  } catch {
    // Quota exceeded, storage disabled, or no sessionStorage at all — silently skip.
    // The in-memory cache still works for the rest of this page's life.
  }
}

/**
 * Run `fn` unless a fresh value for `key` already exists (memory first, then
 * sessionStorage). Resolves with `cached: true` when an existing value was used.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  const now = Date.now();

  const inMem = mem.get(key) as CacheEntry<T> | undefined;
  if (inMem && now - inMem.ts < ttlMs) {
    return { value: inMem.value, cached: true };
  }

  const inSession = readSession<T>(key);
  if (inSession && now - inSession.ts < ttlMs) {
    mem.set(key, inSession);
    return { value: inSession.value, cached: true };
  }

  const value = await fn();
  const entry: CacheEntry<T> = { value, ts: now };
  mem.set(key, entry);
  writeSession(key, entry);
  return { value, cached: false };
}

export function cacheKeyForScrape(url: string): string {
  return `scrape:${url}`;
}

/** Fire-and-forget warm-up so a demo topic is already cached before anyone speaks. */
export function prewarm(urls: string[]): void {
  for (const url of urls) {
    void cached(cacheKeyForScrape(url), DEFAULT_TTL_MS, () => scrapeMarkdown(url)).catch(() => {
      // Best-effort only — a failed prewarm just means the real run pays the cold cost.
    });
  }
}
