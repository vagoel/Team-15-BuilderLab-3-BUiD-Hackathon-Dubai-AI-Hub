import type { SourceCandidate, SourceSet, SourceSetOrigin } from "../contract/artifacts.js";
import { searchWeb } from "./context.js";

/**
 * Source provenance, enforced rather than requested.
 *
 * The old prompt asked the agent to pick "real, specific URLs likely to carry the
 * answer" — which is an invitation to invent one, and it did: plausible URLs that
 * 404, or worse, resolve to something unrelated and get reported as research. The
 * fix is protocol, not wording. Discovery (`search_web`) or explicit registration
 * (`use_direct_urls`) creates a source set here and hands back an opaque id plus
 * numbered candidates. Retrieval takes an id and indexes. A URL the agent made up
 * has nowhere to enter.
 *
 * Sets live for the page's lifetime — they are conversation scratch, not state
 * worth persisting.
 */

const sets = new Map<string, SourceSet>();

/** How many sets to keep before evicting the oldest. A long session should not grow
 * unboundedly, and a set from twenty turns ago is never referenced again. */
const MAX_SETS = 20;

function nextId(): string {
  return `ss_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function remember(set: SourceSet): SourceSet {
  sets.set(set.id, set);
  while (sets.size > MAX_SETS) {
    const oldest = sets.keys().next().value;
    if (oldest === undefined) break;
    sets.delete(oldest);
  }
  return set;
}

export class SourceSetError extends Error {}

/**
 * Accept only URLs a browser can actually fetch over the network.
 *
 * `javascript:` and `data:` are obvious, but the credential form
 * (`https://user:pass@host`) matters just as much: it is how a crafted URL smuggles
 * secrets into a request we then proxy, and no legitimate research page needs it.
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SourceSetError(`"${raw}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceSetError(`${url.protocol} URLs are not supported — use http or https`);
  }
  if (url.username || url.password) {
    throw new SourceSetError("URLs with embedded credentials are not accepted");
  }
  url.hash = "";
  return url.toString();
}

function candidatesFrom(entries: Array<{ url: string; title: string; description?: string; relevance?: string }>): SourceCandidate[] {
  const seen = new Set<string>();
  const out: SourceCandidate[] = [];
  for (const entry of entries) {
    let url: string;
    try {
      url = normalizeUrl(entry.url);
    } catch {
      continue; // A malformed search hit is not worth failing the whole discovery for.
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      index: out.length,
      url,
      title: entry.title || url,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.relevance ? { relevance: entry.relevance } : {}),
    });
  }
  return out;
}

function create(origin: SourceSetOrigin, query: string, candidates: SourceCandidate[]): SourceSet {
  return remember({
    id: nextId(),
    origin,
    query,
    candidates,
    createdAt: new Date().toISOString(),
  });
}

/** Discover pages for a topic question. Retrieval is a separate, later call. */
export async function searchForSources(query: string): Promise<SourceSet> {
  const hits = await searchWeb(query);
  return create("search", query, candidatesFrom(hits));
}

/**
 * Register URLs the user supplied verbatim.
 *
 * This is the only sanctioned way around search, and it is safe precisely because
 * the URLs came from the user rather than the model. They still go through the same
 * validation and the same indexed-retrieval boundary as search results.
 */
export function registerDirectUrls(query: string, urls: string[]): SourceSet {
  const normalized = urls.map((u) => {
    const url = normalizeUrl(u);
    return { url, title: titleFromUrl(url) };
  });
  const candidates = candidatesFrom(normalized);
  if (!candidates.length) throw new SourceSetError("none of those URLs were usable");
  return create("direct", query, candidates);
}

export function getSourceSet(id: string): SourceSet | undefined {
  return sets.get(id);
}

export function knownSourceSetIds(): string[] {
  return [...sets.keys()];
}

/**
 * Turn (id, indexes) into candidates, or explain precisely what went wrong.
 *
 * The error strings are written for the model, not for a log: a tool result saying
 * "index 12 is out of range — this set has 10 candidates (0-9)" is something it can
 * recover from on the next call, which "invalid input" is not.
 */
export function resolveCandidates(sourceSetId: string, indexes: number[]): SourceCandidate[] {
  const set = sets.get(sourceSetId);
  if (!set) {
    const known = knownSourceSetIds();
    throw new SourceSetError(
      `unknown sourceSetId ${sourceSetId}. ` +
        (known.length ? `Use one of: ${known.join(", ")}` : "Call search_web or use_direct_urls first."),
    );
  }
  if (!indexes.length) throw new SourceSetError("pick at least one candidate index");

  const picked: SourceCandidate[] = [];
  const seen = new Set<number>();
  for (const index of indexes) {
    if (seen.has(index)) continue;
    seen.add(index);
    const candidate = set.candidates[index];
    if (!candidate) {
      throw new SourceSetError(
        `index ${index} is out of range — this set has ${set.candidates.length} candidates ` +
          `(0-${Math.max(0, set.candidates.length - 1)})`,
      );
    }
    picked.push(candidate);
  }
  return picked;
}

/** Readable fallback title for a URL with nothing better attached. */
export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const lastSegment = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop();
    if (!lastSegment) return host;
    const decoded = decodeURIComponent(lastSegment).replace(/[-_]+/g, " ").trim();
    return decoded ? `${host} — ${decoded}` : host;
  } catch {
    return url;
  }
}

/** Test seam: drop every registered set. */
export function resetSourceSets(): void {
  sets.clear();
}
