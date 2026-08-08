import { z } from "zod";

/**
 * Raw research contracts: what we discovered, and what we actually fetched.
 *
 * Loom used to hand context.dev a JSON schema and let an LLM fill it in
 * (`/web/extract`). That endpoint is gone. Everything here describes *raw* web
 * material — search hits, markdown pages, crawled pages, image metadata — and the
 * honesty boundary that goes with it: a genuine markdown table can become rows,
 * prose cannot. See `research/pipeline.ts`.
 *
 * Response shapes below were confirmed against the live API before this file was
 * written, not guessed from docs:
 *
 *   POST /web/search   { query, numResults, markdownOptions }
 *     -> { results: [{ url, title, description, relevance, markdown }], query, key_metadata }
 *   GET  /web/scrape/markdown?url=
 *     -> { success, markdown }
 *   POST /web/crawl    { url, limit }
 *     -> { results: [{ markdown, metadata: { sourceUrl, finalUrl, title, crawlDepth, ... } }], ... }
 *   GET  /web/scrape/images?url=
 *     -> { success, images: [{ src, element, type, alt }], url, key_metadata }
 */

// ---------------------------------------------------------------------------
// Source sets — the provenance boundary
// ---------------------------------------------------------------------------

/**
 * One candidate the agent may choose to retrieve.
 *
 * `index` is what the agent passes back. It never passes a URL: that is the whole
 * point — a URL in a tool call could be anything the model invented, whereas an
 * index can only name something discovery actually returned.
 */
export const SourceCandidate = z.object({
  index: z.number().int().min(0),
  url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** context.dev's own ranking hint, when the endpoint supplies one. */
  relevance: z.string().optional(),
});
export type SourceCandidate = z.infer<typeof SourceCandidate>;

export const SourceSetOrigin = z.enum(["search", "direct"]);
export type SourceSetOrigin = z.infer<typeof SourceSetOrigin>;

export const SourceSet = z.object({
  id: z.string(),
  origin: SourceSetOrigin,
  /** The search query, or the phrase the user used when supplying URLs directly. */
  query: z.string(),
  candidates: z.array(SourceCandidate),
  createdAt: z.string(),
});
export type SourceSet = z.infer<typeof SourceSet>;

// ---------------------------------------------------------------------------
// Raw artifacts
// ---------------------------------------------------------------------------

export const RetrievalMode = z.enum(["markdown", "crawl", "images"]);
export type RetrievalMode = z.infer<typeof RetrievalMode>;

export const ImageAsset = z.object({
  src: z.string(),
  alt: z.string().optional(),
  /** context.dev reports how the image appeared in the page: `img`, `background`, … */
  element: z.string().optional(),
  sourceId: z.string(),
});
export type ImageAsset = z.infer<typeof ImageAsset>;

const artifactBase = {
  /** The Source this came from, so every downstream card can attribute itself. */
  sourceId: z.string(),
  url: z.string(),
  title: z.string(),
  fetchedAt: z.string(),
};

export const MarkdownArtifact = z.object({
  ...artifactBase,
  kind: z.literal("markdown"),
  markdown: z.string(),
});

export const CrawlArtifact = z.object({
  ...artifactBase,
  kind: z.literal("crawl"),
  markdown: z.string(),
  depth: z.number().int().min(0).default(0),
});

export const ImagesArtifact = z.object({
  ...artifactBase,
  kind: z.literal("images"),
  images: z.array(ImageAsset),
});

export const ResearchArtifact = z.discriminatedUnion("kind", [
  MarkdownArtifact,
  CrawlArtifact,
  ImagesArtifact,
]);
export type ResearchArtifact = z.infer<typeof ResearchArtifact>;

/** Every artifact that carries page text, for `read_source` and table parsing. */
export function artifactText(artifact: ResearchArtifact): string {
  return artifact.kind === "images" ? "" : artifact.markdown;
}

// ---------------------------------------------------------------------------
// Limits
//
// Every one of these is a spend cap as much as a correctness cap: context.dev bills
// per call and per crawled page, and the agent will happily ask for more than a demo
// can afford.
// ---------------------------------------------------------------------------

export const LIMITS: Record<
  | "searchResults"
  | "maxSourcesPerCollect"
  | "defaultCrawlPages"
  | "maxCrawlPages"
  | "maxImagesPerSource"
  | "maxExcerptChars",
  number
> = {
  /** The API's own minimum; asking for fewer is rejected, more just costs more. */
  searchResults: 10,
  /** How many candidates one collect_sources call may retrieve. */
  maxSourcesPerCollect: 8,
  /** Pages per crawl, and the hard ceiling regardless of what the agent asks for. */
  defaultCrawlPages: 5,
  maxCrawlPages: 12,
  /** Images kept per source after de-duplication. */
  maxImagesPerSource: 24,
  /** Characters of page text returned to the *model* (the browser keeps it all). */
  maxExcerptChars: 1500,
};
