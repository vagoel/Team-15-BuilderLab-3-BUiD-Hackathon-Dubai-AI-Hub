import type {
  DataRecord,
  Dataset,
  DatasetImage,
  FieldSpec,
  Finding,
  ResearchSummary,
  Source,
} from "../contract/dataset.js";
import { LIMITS, type RetrievalMode } from "../contract/artifacts.js";
import { useLoom } from "../store.js";
import { cached, cacheKeyForScrape, DEFAULT_TTL_MS } from "./cache.js";
import { ContextApiError, crawlSite, getBrand, scrapeImages, scrapeMarkdown } from "./context.js";
import { inferTableFromMarkdown } from "./markdownTable.js";
import { resolveCandidates, titleFromUrl } from "./sourceSets.js";

/**
 * The research run. See src/research/index.ts for the public surface — this file
 * holds the mechanics.
 *
 * Everything here works from *raw* web material. There is no structured-extraction
 * endpoint and no heuristic row synthesis: a report gains rows only where a page
 * printed a real table, and prose contributes sources the agent can quote instead.
 * That trade is deliberate — a page that yields nothing is a better outcome than a
 * page that yields a convincing invention.
 *
 * Sources are fetched in parallel (Promise.allSettled) and the zustand store is
 * updated as each one lands, so the UI fills in while the rest are still in flight.
 * A source that fails degrades to `{ error }` rather than aborting the run; a run
 * where every source fails still resolves with a usable summary.
 */

export interface ResearchHooks {
  /**
   * Fires as soon as the dataset exists in the store, before any page has been read.
   * Callers use it to mount a provisional layout so source rows appear immediately
   * and fill in as pages land.
   */
  onStart?: (datasetId: string, sources: Source[]) => void;
  onSourceFound?: (s: Source) => void;
  onSourceRead?: (sourceId: string, ms: number, cached: boolean) => void;
  onSourceFailed?: (sourceId: string, error: string) => void;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface RunResearchParams {
  question: string;
  /** From search_web or use_direct_urls — never a caller-supplied URL list. */
  sourceSetId: string;
  /** Which candidates of that set to retrieve. */
  indexes: number[];
  mode: RetrievalMode;
  /** Crawl mode only: pages to visit, clamped to LIMITS.maxCrawlPages. */
  crawlPages?: number;
}

export interface DeepenResearchParams {
  datasetId: string;
  angle: string;
}

// ---------------------------------------------------------------------------
// Source id -> {url, title} registry, so readSource(id) works without a caller
// having to carry the whole Dataset around. Populated as sources are created.
// ---------------------------------------------------------------------------

const sourceRegistry = new Map<string, { url: string; title: string }>();

function registerSources(sources: Source[]): void {
  for (const s of sources) sourceRegistry.set(s.id, { url: s.url, title: s.title });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function shortId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function titleFromMarkdown(markdown: string): string | undefined {
  const m = markdown.match(/^#\s+(.+)$/m);
  const text = m?.[1]?.trim();
  return text && text.length > 0 && text.length < 120 ? text : undefined;
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function formatNum(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString("en-US")
    : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Hook safety
//
// Hooks are UI side-effects supplied by a caller we don't control. A hook that
// throws must never take the research run down with it.
// ---------------------------------------------------------------------------

function safeHook<Args extends unknown[]>(fn: ((...args: Args) => void) | undefined, ...args: Args): void {
  if (!fn) return;
  try {
    fn(...args);
  } catch (err) {
    console.error("[research] hook threw, ignoring:", err);
  }
}

/**
 * Build the Source to report after a failed fetch attempt.
 *
 * A source that already succeeded once (`fetchedAt` set — e.g. deepen re-fetching an
 * existing source under a new angle) must not flip to `.error` just because the new
 * attempt failed: the dataset still carries what that source contributed the first
 * time, so treating it as failed would desync the succeeded/failed counts from what
 * `records` actually holds.
 */
function buildFailedSource(source: Source, message: string): Source {
  return source.fetchedAt ? { ...source } : { ...source, error: message };
}

/** Minimum length (whitespace collapsed) before scraped markdown counts as a real
 * page rather than an error stub or a near-empty shell. */
const MIN_SUBSTANTIVE_MARKDOWN_LENGTH = 60;

function isSubstantiveMarkdown(markdown: string): boolean {
  return markdown.replace(/\s+/g, " ").trim().length >= MIN_SUBSTANTIVE_MARKDOWN_LENGTH;
}

// ---------------------------------------------------------------------------
// Field merging
//
// Each page infers its own schema from its own table headers, so two sources can
// disagree. Union them by key and keep the first non-string type seen: a column
// typed `currency` on one page and `string` on another (because that page had an
// "N/A") is still money, and typing it as text costs every chart it could feed.
// ---------------------------------------------------------------------------

function mergeFields(into: FieldSpec[], incoming: FieldSpec[]): FieldSpec[] {
  const byKey = new Map(into.map((f) => [f.key, f]));
  for (const field of incoming) {
    const existing = byKey.get(field.key);
    if (!existing) {
      byKey.set(field.key, field);
      continue;
    }
    if (existing.type === "string" && field.type !== "string") {
      byKey.set(field.key, { ...existing, type: field.type, unit: field.unit ?? existing.unit });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Findings / headline — mechanically derived, no LLM in this path.
//
// The agent may add its own cited findings on top via set_research_findings; these
// are the ones we can state without reading anything.
// ---------------------------------------------------------------------------

function generateFindings(
  records: DataRecord[],
  fields: FieldSpec[],
  sources: Source[],
  images: DatasetImage[],
): Finding[] {
  const lines: string[] = [];
  const succeeded = sources.filter((s) => s.fetchedAt && !s.error).length;
  const failed = sources.filter((s) => s.error).length;

  if (records.length === 0) {
    if (failed > 0 && succeeded === 0) {
      lines.push(`All ${failed} source${failed === 1 ? "" : "s"} failed to load — nothing was read.`);
    } else if (images.length > 0) {
      lines.push(`${images.length} image${images.length === 1 ? "" : "s"} collected across ${succeeded} source${succeeded === 1 ? "" : "s"}.`);
    } else {
      // Said plainly on purpose. Most of the web is prose, and "no table here" is
      // the honest result — not a reason to manufacture rows.
      lines.push(
        `Read ${succeeded} source${succeeded === 1 ? "" : "s"}, none of which published a table. ` +
          "The pages are available to quote from.",
      );
    }
  } else {
    lines.push(
      `${records.length} row${records.length === 1 ? "" : "s"} read from tables across ${succeeded} source${succeeded === 1 ? "" : "s"}.`,
    );
  }

  if (failed > 0 && records.length > 0) {
    lines.push(
      `${failed} of ${sources.length} source${sources.length === 1 ? "" : "s"} failed to load and ${failed === 1 ? "was" : "were"} skipped.`,
    );
  }

  const numericFields = fields.filter((f) => f.type === "number" || f.type === "currency");
  for (const field of numericFields) {
    const values = records.map((r) => r[field.key]).filter((v): v is number => typeof v === "number");
    if (values.length === 0) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const unitSuffix = field.unit ? ` ${field.unit}` : "";
    lines.push(
      min === max
        ? `${field.label}: all ${values.length} value${values.length === 1 ? "" : "s"} are ${formatNum(min)}${unitSuffix}.`
        : `${field.label} ranges ${formatNum(min)}${unitSuffix} to ${formatNum(max)}${unitSuffix} across ${values.length} value${values.length === 1 ? "" : "s"}.`,
    );
  }

  if (lines.length < 3 && fields.length > 0) {
    lines.push(`Columns read: ${fields.map((f) => f.label).join(", ")}.`);
  }
  if (lines.length < 3 && sources.length > 0) {
    lines.push(`Sources read: ${sources.map((s) => s.title).join(", ")}.`);
  }

  return lines.slice(0, 6).map((text) => ({ text, sourceIds: [] as string[] }));
}

function generateHeadline(
  question: string,
  records: DataRecord[],
  sources: Source[],
  fields: FieldSpec[],
  images: DatasetImage[],
): string {
  const succeeded = sources.filter((s) => s.fetchedAt && !s.error).length;

  if (records.length === 0) {
    if (succeeded === 0) {
      return `Could not read any of the ${sources.length} source${sources.length === 1 ? "" : "s"} for "${question}".`;
    }
    if (images.length > 0) {
      return `${images.length} image${images.length === 1 ? "" : "s"} from ${succeeded} source${succeeded === 1 ? "" : "s"}.`;
    }
    return `${succeeded} source${succeeded === 1 ? "" : "s"} read for "${question}" — no tables to extract rows from.`;
  }

  const numericField = fields.find((f) => f.type === "currency" || f.type === "number");
  if (numericField) {
    const values = records.map((r) => r[numericField.key]).filter((v): v is number => typeof v === "number");
    if (values.length > 0) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const unitSuffix = numericField.unit ? ` ${numericField.unit}` : "";
      const range = min === max ? `${formatNum(min)}${unitSuffix}` : `${formatNum(min)}–${formatNum(max)}${unitSuffix}`;
      return `${records.length} row${records.length === 1 ? "" : "s"} across ${succeeded} source${succeeded === 1 ? "" : "s"}, ${range}.`;
    }
  }

  return `${records.length} row${records.length === 1 ? "" : "s"} across ${succeeded} source${succeeded === 1 ? "" : "s"}.`;
}

function buildSummary(dataset: Dataset): ResearchSummary {
  return {
    datasetId: dataset.id,
    headline: dataset.headline,
    keyFindings: dataset.findings.slice(0, 3).map((f) => f.text),
    sourceCount: dataset.sources.length,
    recordCount: dataset.records.length,
    availableFields: dataset.fields.map((f) => ({ key: f.key, label: f.label, type: f.type })),
  };
}

// ---------------------------------------------------------------------------
// Per-source retrieval. Never throws — always resolves with an updated Source
// (possibly carrying `.error`) plus whatever it managed to read.
// ---------------------------------------------------------------------------

interface SourceProcessResult {
  source: Source;
  records: DataRecord[];
  fields: FieldSpec[];
  images: DatasetImage[];
}

function cacheKeyForCrawl(url: string, pages: number): string {
  return `crawl:${url}:${pages}`;
}

function cacheKeyForImages(url: string): string {
  return `images:${url}`;
}

/** De-duplicate and cap a page's images. A busy article returns hundreds of icons
 * and sprites; the gallery wants the handful that mean something. */
function normalizeImages(raw: Array<{ src: string; alt?: string }>, sourceId: string): DatasetImage[] {
  const seen = new Set<string>();
  const out: DatasetImage[] = [];
  for (const image of raw) {
    // Inline data URIs are almost always spacers and blow up the store.
    if (!/^https?:\/\//i.test(image.src)) continue;
    if (seen.has(image.src)) continue;
    seen.add(image.src);
    out.push({ src: image.src, ...(image.alt ? { alt: image.alt } : {}), sourceId });
    if (out.length >= LIMITS.maxImagesPerSource) break;
  }
  return out;
}

async function processSource(
  source: Source,
  mode: RetrievalMode,
  crawlPages: number,
  hooks: ResearchHooks | undefined,
): Promise<SourceProcessResult> {
  const start = nowMs();

  const fail = (message: string): SourceProcessResult => {
    safeHook(hooks?.onSourceFailed, source.id, message);
    return { source: buildFailedSource(source, message), records: [], fields: [], images: [] };
  };

  try {
    if (mode === "images") {
      const { value: raw, cached: wasCached } = await cached(cacheKeyForImages(source.url), DEFAULT_TTL_MS, () =>
        scrapeImages(source.url),
      );
      const images = normalizeImages(raw, source.id);
      if (!images.length) throw new Error("no usable images on that page");
      safeHook(hooks?.onSourceRead, source.id, nowMs() - start, wasCached);
      console.info(`[research] ${source.url}: ${images.length} image(s)`);
      return {
        source: { ...source, fetchedAt: new Date().toISOString() },
        records: [],
        fields: [],
        images,
      };
    }

    // markdown and crawl both come back as page text; crawl just returns several.
    const pages: Array<{ url: string; title?: string; markdown: string }> = [];
    let wasCached = false;

    if (mode === "crawl") {
      const result = await cached(cacheKeyForCrawl(source.url, crawlPages), DEFAULT_TTL_MS, () =>
        crawlSite(source.url, crawlPages),
      );
      wasCached = result.cached;
      pages.push(...result.value);
    } else {
      const result = await cached(cacheKeyForScrape(source.url), DEFAULT_TTL_MS, () => scrapeMarkdown(source.url));
      wasCached = result.cached;
      pages.push({ url: source.url, markdown: result.value });
    }

    const usable = pages.filter((p) => isSubstantiveMarkdown(p.markdown));
    if (!usable.length) throw new Error("the page had no substantive content");

    let records: DataRecord[] = [];
    let fields: FieldSpec[] = [];
    for (const page of usable) {
      // The only place rows are ever created: a table the page actually printed.
      const table = inferTableFromMarkdown(page.markdown);
      if (!table) continue;
      fields = mergeFields(fields, table.fields);
      records = records.concat(table.records.map((r) => ({ ...r, _source: source.id })));
    }

    const firstPage = usable[0]!;
    const title = titleFromMarkdown(firstPage.markdown) ?? source.title;
    safeHook(hooks?.onSourceRead, source.id, nowMs() - start, wasCached);
    console.info(
      `[research] ${source.url}: ${usable.length} page(s) via ${mode}, ${records.length} row(s) from real tables`,
    );

    // Zero rows is a legitimate, reportable outcome — the page is still a source
    // the agent can read and quote. It is NOT a failure and must not be one.
    return {
      source: { ...source, title, fetchedAt: new Date().toISOString() },
      records,
      fields,
      images: [],
    };
  } catch (err) {
    if (err instanceof ContextApiError && err.status === 429) {
      return fail(`rate limited by context.dev${err.retryAfterSeconds ? ` — retry in ${err.retryAfterSeconds}s` : ""}`);
    }
    return fail(describeError(err));
  }
}

// ---------------------------------------------------------------------------
// Brand enrichment — best-effort, fire-and-forget.
// ---------------------------------------------------------------------------

async function enrichBrandsInBackground(datasetId: string, sources: Source[]): Promise<void> {
  const hostnames = Array.from(new Set(sources.map((s) => hostnameOf(s.url)).filter((h): h is string => !!h)));

  await Promise.allSettled(
    hostnames.map(async (hostname) => {
      try {
        const { value: brand } = await cached(`brand:${hostname}`, DEFAULT_TTL_MS, () => getBrand(hostname));
        if (!brand.name && !brand.logoUrl && !brand.color) return;
        const current = useLoom.getState().datasets[datasetId];
        if (!current) return;
        const nextSources = current.sources.map((s) =>
          hostnameOf(s.url) === hostname
            ? { ...s, brand: { name: brand.name, logoUrl: brand.logoUrl, color: brand.color } }
            : s,
        );
        useLoom.getState().upsertDataset(datasetId, { sources: nextSources });
      } catch {
        // Decorative only — never surfaced, never blocks the run.
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Public entry points (re-exported from index.ts)
// ---------------------------------------------------------------------------

export async function runResearch(params: RunResearchParams, hooks?: ResearchHooks): Promise<ResearchSummary> {
  // Throws for an unknown set or an out-of-range index; the handler turns that into
  // a short recoverable string. Retrieval cannot begin from an unregistered URL.
  const candidates = resolveCandidates(params.sourceSetId, params.indexes).slice(
    0,
    LIMITS.maxSourcesPerCollect,
  );

  const datasetId = shortId("ds_");
  const label = params.mode === "images" ? "Collecting images" : "Reading sources";
  const total = candidates.length;
  const crawlPages = Math.max(1, Math.min(params.crawlPages ?? LIMITS.defaultCrawlPages, LIMITS.maxCrawlPages));

  const sources: Source[] = candidates.map((c) => ({
    id: shortId("src_"),
    url: c.url,
    title: c.title || titleFromUrl(c.url),
  }));
  registerSources(sources);

  for (const s of sources) safeHook(hooks?.onSourceFound, s);
  safeHook(hooks?.onProgress, 0, total, label);

  const createdAt = new Date().toISOString();
  const initialDataset: Dataset = {
    id: datasetId,
    question: params.question,
    headline: "Researching…",
    createdAt,
    sources,
    fields: [],
    records: [],
    findings: [],
  };
  useLoom.getState().addDataset(initialDataset);
  safeHook(hooks?.onStart, datasetId, sources);

  void enrichBrandsInBackground(datasetId, sources);

  let done = 0;
  let allRecords: DataRecord[] = [];
  let allFields: FieldSpec[] = [];
  let allImages: DatasetImage[] = [];
  const updatedSources: Source[] = [...sources];

  const tasks = sources.map((source, i) =>
    processSource(source, params.mode, crawlPages, hooks).then((result) => {
      done += 1;
      updatedSources[i] = result.source;
      allRecords = allRecords.concat(result.records);
      allFields = mergeFields(allFields, result.fields);
      allImages = allImages.concat(result.images);
      safeHook(hooks?.onProgress, done, total, label);
      useLoom.getState().upsertDataset(datasetId, {
        sources: [...updatedSources],
        fields: [...allFields],
        records: [...allRecords],
        images: [...allImages],
      });
      return result;
    }),
  );

  await Promise.allSettled(tasks);

  // Preserve any brand data that landed via background enrichment before we
  // overwrite the dataset with the final assembly.
  const liveSources = useLoom.getState().datasets[datasetId]?.sources ?? updatedSources;
  const sourcesWithBrand = updatedSources.map((s) => {
    const withBrand = liveSources.find((ls) => ls.id === s.id);
    return withBrand?.brand ? { ...s, brand: withBrand.brand } : s;
  });

  const findings = generateFindings(allRecords, allFields, sourcesWithBrand, allImages);
  const headline = generateHeadline(params.question, allRecords, sourcesWithBrand, allFields, allImages);

  const finalDataset: Dataset = {
    id: datasetId,
    question: params.question,
    headline,
    createdAt,
    sources: sourcesWithBrand,
    fields: allFields,
    records: allRecords,
    findings,
    ...(allImages.length ? { images: allImages } : {}),
  };
  useLoom.getState().addDataset(finalDataset);
  registerSources(sourcesWithBrand);

  return buildSummary(finalDataset);
}

/**
 * Re-read an existing dataset's sources under a new angle.
 *
 * Extends the dataset *in place* — same id — so components already bound to it pick
 * the new rows up without a re-render. A fresh id would leave the visible dashboard
 * pointing at stale data until the agent rebuilt it, which remounts every chart.
 */
export async function deepenResearch(params: DeepenResearchParams, hooks?: ResearchHooks): Promise<ResearchSummary> {
  const existing = useLoom.getState().datasets[params.datasetId];
  if (!existing) {
    const message = `Could not find dataset ${params.datasetId} to deepen.`;
    safeHook(hooks?.onProgress, 0, 0, message);
    return {
      datasetId: params.datasetId,
      headline: message,
      keyFindings: [message],
      sourceCount: 0,
      recordCount: 0,
      availableFields: [],
    };
  }

  const label = `Deepening: ${params.angle}`;
  const total = existing.sources.length;

  for (const s of existing.sources) safeHook(hooks?.onSourceFound, s);
  safeHook(hooks?.onProgress, 0, total, label);

  let done = 0;
  let newRecords: DataRecord[] = [];
  let newFields: FieldSpec[] = existing.fields;
  const updatedSources: Source[] = [...existing.sources];

  const tasks = existing.sources.map((source, i) =>
    // Deepen re-reads with a bounded crawl: the same page again would just be the
    // cached markdown, whereas following its links is what "go deeper" means.
    processSource(source, "crawl", LIMITS.defaultCrawlPages, hooks).then((result) => {
      done += 1;
      updatedSources[i] = result.source;
      newRecords = newRecords.concat(result.records);
      newFields = mergeFields(newFields, result.fields);
      safeHook(hooks?.onProgress, done, total, label);
      useLoom.getState().upsertDataset(params.datasetId, {
        sources: [...updatedSources],
        fields: [...newFields],
        records: existing.records.concat(newRecords),
      });
      return result;
    }),
  );

  await Promise.allSettled(tasks);

  const mergedRecords = existing.records.concat(newRecords);
  const images = existing.images ?? [];
  const findings = generateFindings(mergedRecords, newFields, updatedSources, images);
  const headline = generateHeadline(existing.question, mergedRecords, updatedSources, newFields, images);

  const finalDataset: Dataset = {
    ...existing,
    headline,
    sources: updatedSources,
    fields: newFields,
    records: mergedRecords,
    findings,
  };
  useLoom.getState().addDataset(finalDataset);
  registerSources(updatedSources);

  return buildSummary(finalDataset);
}

export async function readSource(sourceId: string): Promise<{ title: string; url: string; markdown: string }> {
  const entry = sourceRegistry.get(sourceId);
  if (!entry) throw new Error(`Unknown source id: ${sourceId}`);

  const { value: markdown } = await cached(cacheKeyForScrape(entry.url), DEFAULT_TTL_MS, () =>
    scrapeMarkdown(entry.url),
  );
  const title = titleFromMarkdown(markdown) ?? entry.title;
  return { title, url: entry.url, markdown };
}

/** True when `sourceId` belongs to this dataset — the check behind cited findings. */
export function datasetHasSource(datasetId: string, sourceId: string): boolean {
  const dataset = useLoom.getState().datasets[datasetId];
  return dataset ? dataset.sources.some((s) => s.id === sourceId) : false;
}

export function getDataset(id: string): Dataset | undefined {
  return useLoom.getState().datasets[id];
}
