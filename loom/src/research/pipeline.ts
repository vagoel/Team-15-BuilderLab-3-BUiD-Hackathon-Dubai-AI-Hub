import type { DataRecord, Dataset, FieldSpec, Finding, ResearchSummary, Source } from "../contract/dataset.js";
import { useLoom } from "../store.js";
import { cached, cacheKeyForScrape, DEFAULT_TTL_MS } from "./cache.js";
import { ContextApiError, extractStructured, getBrand, scrapeMarkdown } from "./context.js";
import { recordsFromMarkdown } from "./markdownTable.js";

/**
 * The research run. See src/research/index.ts for the public surface — this file
 * holds the mechanics.
 *
 * Sources are fetched in parallel (Promise.allSettled) and the zustand store is
 * updated as each one lands, so the UI fills in while the rest are still in
 * flight. A source that fails degrades to `{ error }` rather than aborting the
 * run; a run where every source fails still resolves with a usable summary.
 */

export interface ResearchHooks {
  /**
   * Fires as soon as the dataset exists in the store, before any page has been read.
   *
   * Extraction runs about 20s against a cold URL, and without this the canvas stays
   * empty for that whole stretch. Callers use it to mount a provisional layout so
   * source rows appear within a second and fill in as pages land.
   */
  onStart?: (datasetId: string, sources: Source[]) => void;
  onSourceFound?: (s: Source) => void;
  onSourceRead?: (sourceId: string, ms: number, cached: boolean) => void;
  onSourceFailed?: (sourceId: string, error: string) => void;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface RunResearchParams {
  question: string;
  seedUrls: string[];
  fields: FieldSpec[];
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

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const lastSegment = u.pathname
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .pop();
    if (!lastSegment) return host;
    const decoded = decodeURIComponent(lastSegment).replace(/[-_]+/g, " ").trim();
    return decoded ? `${host} — ${decoded}` : host;
  } catch {
    return url;
  }
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Hook safety
//
// Hooks are UI side-effects supplied by a caller we don't control. A hook that
// throws must never take the research run down with it — it would abort the
// Promise.allSettled-wrapped source task early and skip the store update that
// follows it in the same .then(), for no reason related to the actual fetch.
// ---------------------------------------------------------------------------

function safeHook<Args extends unknown[]>(fn: ((...args: Args) => void) | undefined, ...args: Args): void {
  if (!fn) return;
  try {
    fn(...args);
  } catch (err) {
    console.error("[research] hook threw, ignoring:", err);
  }
}

// ---------------------------------------------------------------------------
// Failure classification — is a fallback to the heuristic markdown path worth
// attempting, or is the extract failure definitive?
// ---------------------------------------------------------------------------

/** Statuses where there is definitively nothing to read, on either endpoint. */
const NON_RETRYABLE_STATUSES = new Set([401, 404]);

/**
 * 401 (USAGE_EXCEEDED) means the key has no credits left — the plain scrape call
 * would fail the exact same way, so trying it just burns latency for a guaranteed
 * second failure. 404 (NOT_FOUND) means the page itself does not exist — a "clean"
 * markdown scrape of a dead URL is a generic error page at best, and running the
 * heuristic extractor over it manufactures a row that looks real but describes
 * nothing on that URL. Everything else (timeouts, aborts, 5xx, network errors,
 * a malformed-but-200 response) is plausibly transient and worth a second attempt
 * via the plain scrape.
 */
function isRetryableFailure(err: unknown): boolean {
  if (err instanceof ContextApiError) return !NON_RETRYABLE_STATUSES.has(err.status);
  return true;
}

/** Minimum length (whitespace collapsed) before scraped markdown is trusted enough
 * to run the heuristic extractor over. Guards against generic error pages / near-
 * empty responses producing a fabricated-looking row out of boilerplate. */
const MIN_SUBSTANTIVE_MARKDOWN_LENGTH = 60;

function isSubstantiveMarkdown(markdown: string): boolean {
  return markdown.replace(/\s+/g, " ").trim().length >= MIN_SUBSTANTIVE_MARKDOWN_LENGTH;
}

/** True if a record has at least one non-null field — an all-null record carries no
 * information and must not be counted as a row anyone could actually read. */
function hasAnyValue(record: DataRecord): boolean {
  return Object.values(record).some((v) => v !== null);
}

/**
 * Build the Source to report after a failed fetch attempt.
 *
 * A source that already succeeded once (`fetchedAt` set — e.g. deepen re-fetching an
 * existing source under a new angle) must not flip to `.error` just because the new
 * attempt failed: the dataset still carries the records that source contributed the
 * first time around, so treating it as failed would desync `generateFindings`'s
 * succeeded/failed counts from what `records` actually holds, while also hiding a
 * source that genuinely has data behind an "error" flag. Only a source with no prior
 * success gets marked failed.
 */
function buildFailedSource(source: Source, message: string): Source {
  return source.fetchedAt ? { ...source } : { ...source, error: message };
}

// ---------------------------------------------------------------------------
// Heuristic fallback extraction — used only when the real extract API is
// unavailable or comes back unusable. Regex proximity search around the field
// label/key; deliberately simple, one record per page.
// ---------------------------------------------------------------------------

function extractFieldHeuristically(markdown: string, field: FieldSpec): string | number | null {
  const labelPattern = escapeRegExp(field.label);
  const keyPattern = escapeRegExp(field.key.replace(/_/g, " "));
  const labelRe = new RegExp(`(?:${labelPattern}|${keyPattern})`, "i");
  const labelMatch = markdown.match(labelRe);

  // If the field's label/key does not appear anywhere on the page, there is nothing
  // to anchor a proximity search to. The currency/number/date/url branches below
  // used to fall back to scanning the *entire* page for any matching pattern in
  // that case — which means an unrelated number in the nav, a copyright year in the
  // footer, or someone else's link on the page would get reported as this field's
  // value. That is exactly the "looks real but is not" row this fallback exists to
  // avoid, so: no label match, no value, full stop.
  if (labelMatch?.index === undefined) return null;
  const anchor = labelMatch.index;
  const windowText = markdown.slice(anchor, anchor + labelMatch[0].length + 80);

  switch (field.type) {
    case "currency": {
      const m = windowText.match(/[$€£¥₹]?\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s?(k|K|m|M)?/);
      const numStr = m?.[1];
      if (!numStr) return null;
      let num = Number.parseFloat(numStr.replace(/,/g, ""));
      const suffix = m?.[2];
      if (suffix && /k/i.test(suffix)) num *= 1_000;
      if (suffix && /m/i.test(suffix)) num *= 1_000_000;
      return Number.isFinite(num) ? num : null;
    }
    case "number": {
      const m = windowText.match(/-?[0-9][0-9,]*(?:\.[0-9]+)?/);
      if (!m) return null;
      const num = Number.parseFloat(m[0].replace(/,/g, ""));
      return Number.isFinite(num) ? num : null;
    }
    case "date": {
      const m = windowText.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]+ \d{1,2},? \d{4})\b/);
      return m ? m[0] : null;
    }
    case "url": {
      const m = windowText.match(/https?:\/\/[^\s)\]]+/);
      return m ? m[0] : null;
    }
    case "string":
    default: {
      const after = markdown.slice(anchor + labelMatch[0].length);
      const m = after.match(/[A-Za-z0-9][^\n|]{1,80}/);
      return m ? m[0].trim() : null;
    }
  }
}

function heuristicExtract(markdown: string, fields: FieldSpec[]): DataRecord {
  const record: DataRecord = {};
  for (const field of fields) record[field.key] = extractFieldHeuristically(markdown, field);
  return record;
}

// ---------------------------------------------------------------------------
// Findings / headline — mechanically derived, no LLM in this path.
// ---------------------------------------------------------------------------

function generateFindings(records: DataRecord[], fields: FieldSpec[], sources: Source[]): Finding[] {
  const lines: string[] = [];
  const succeeded = sources.filter((s) => s.fetchedAt && !s.error).length;
  const failed = sources.filter((s) => s.error).length;

  if (records.length === 0) {
    lines.push(
      failed > 0 && succeeded === 0
        ? `All ${failed} source${failed === 1 ? "" : "s"} failed to load — no data extracted.`
        : "No data could be extracted from the sources read.",
    );
  } else {
    lines.push(
      `${records.length} record${records.length === 1 ? "" : "s"} extracted across ${succeeded} source${succeeded === 1 ? "" : "s"}.`,
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
    lines.push(`Fields captured: ${fields.map((f) => f.label).join(", ")}.`);
  }
  if (lines.length < 3 && sources.length > 0) {
    lines.push(`Sources read: ${sources.map((s) => s.title).join(", ")}.`);
  }

  return lines.slice(0, 6).map((text) => ({ text, sourceIds: [] as string[] }));
}

function generateHeadline(question: string, records: DataRecord[], sources: Source[], fields: FieldSpec[]): string {
  const succeeded = sources.filter((s) => s.fetchedAt && !s.error).length;

  if (records.length === 0) {
    return succeeded === 0
      ? `Could not read any of the ${sources.length} source${sources.length === 1 ? "" : "s"} for "${question}".`
      : `No extractable data found across ${succeeded} source${succeeded === 1 ? "" : "s"} for "${question}".`;
  }

  const numericField = fields.find((f) => f.type === "currency" || f.type === "number");
  if (numericField) {
    const values = records.map((r) => r[numericField.key]).filter((v): v is number => typeof v === "number");
    if (values.length > 0) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const unitSuffix = numericField.unit ? ` ${numericField.unit}` : "";
      const range = min === max ? `${formatNum(min)}${unitSuffix}` : `${formatNum(min)}–${formatNum(max)}${unitSuffix}`;
      return `${records.length} record${records.length === 1 ? "" : "s"} across ${succeeded} source${succeeded === 1 ? "" : "s"}, ${range}.`;
    }
  }

  return `${records.length} record${records.length === 1 ? "" : "s"} across ${succeeded} source${succeeded === 1 ? "" : "s"}.`;
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
// Per-source fetch, in three tiers. Never throws — always resolves with an
// updated Source (possibly carrying `.error`) and zero or more records.
//
//   1. Raw markdown + table parse. Sub-second and exhaustive when the page's
//      data is tabular. This is the path that turns a Wikipedia list page into
//      the 487 rows it actually contains.
//   2. /web/extract. The LLM path — right for prose pages with nothing to parse,
//      but it summarises long lists no matter how the instructions are worded,
//      and costs ~22s per URL.
//   3. Heuristic regex over the same markdown. One coarse row, last resort.
//
// Tiers 1 and 3 share one cached scrape, so the fallback costs no extra request.
// ---------------------------------------------------------------------------

interface SourceProcessResult {
  source: Source;
  records: DataRecord[];
}

/** Below this, a "table" is more likely an infobox than a dataset, and the LLM
 * path is the better answer for the page. Two rows is the smallest thing that is
 * recognisably a list rather than a single fact rendered in a box. */
const MIN_TABLE_RECORDS = 2;

function cacheKeyForExtract(url: string, fields: FieldSpec[], angle?: string): string {
  // Every part of a FieldSpec that changes the actual JSON schema/description sent
  // to the API must be in the key — label and unit both flow into the request body
  // (see jsonSchemaTypeFor), so two calls that differ only in unit ("AED" vs "USD")
  // are genuinely different requests and must not share a cache entry.
  const fieldsKey = fields.map((f) => `${f.key}:${f.type}:${f.unit ?? ""}:${f.label}`).join("|");
  return `extract:${url}:${fieldsKey}:${angle ?? ""}`;
}

async function processSource(
  source: Source,
  fields: FieldSpec[],
  question: string,
  angle: string | undefined,
  hooks: ResearchHooks | undefined,
): Promise<SourceProcessResult> {
  const start = nowMs();
  const instructions = angle
    ? `Extract every distinct row or item on the page relevant to: "${question}" — with particular ` +
      `attention to: ${angle}. One record per row. Use null for anything not present. Do not invent data.`
    : undefined;

  const fail = (message: string): SourceProcessResult => {
    safeHook(hooks?.onSourceFailed, source.id, message);
    return { source: buildFailedSource(source, message), records: [] };
  };

  const succeed = (
    records: DataRecord[],
    ms: number,
    wasCached: boolean,
    title?: string,
  ): SourceProcessResult => {
    safeHook(hooks?.onSourceRead, source.id, ms, wasCached);
    const updatedSource: Source = {
      ...source,
      title: title ?? source.title,
      fetchedAt: new Date().toISOString(),
    };
    return { source: updatedSource, records: records.map((r) => ({ ...r, _source: source.id })) };
  };

  // --- tier 1: raw markdown, parsed as tables ------------------------------
  //
  // A failure here is never fatal: the page may simply not be tabular, which is
  // exactly what the extract path below is for.
  let scrapedMarkdown: string | undefined;
  try {
    const { value: markdown, cached: wasCached } = await cached(
      cacheKeyForScrape(source.url),
      DEFAULT_TTL_MS,
      () => scrapeMarkdown(source.url),
    );
    scrapedMarkdown = markdown;
    const tableRecords = recordsFromMarkdown(markdown, fields);
    if (tableRecords.length >= MIN_TABLE_RECORDS) {
      const ms = nowMs() - start;
      console.info(
        `[research] ${source.url}: parsed ${tableRecords.length} record(s) from raw markdown tables`,
      );
      return succeed(tableRecords, ms, wasCached, titleFromMarkdown(markdown) ?? source.title);
    }
  } catch (scrapeErr) {
    // 401/404 mean there is nothing to read on any endpoint — stop here rather
    // than spending the extract budget to fail the same way.
    if (!isRetryableFailure(scrapeErr)) return fail(describeError(scrapeErr));
  }

  // --- tier 2: /web/extract, with tier 3 behind it -------------------------
  try {
    const { value: records, cached: wasCached } = await cached(
      cacheKeyForExtract(source.url, fields, angle),
      DEFAULT_TTL_MS,
      () => extractStructured(source.url, fields, instructions),
    );
    if (records.length === 0) {
      // Real API responded but found nothing usable — fall through to heuristic.
      throw new ContextApiError(200, "extract returned zero records", "/web/extract");
    }
    const ms = nowMs() - start;
    console.info(`[research] ${source.url}: extracted ${records.length} record(s) via context.dev /web/extract`);
    return succeed(records, ms, wasCached);
  } catch (extractErr) {
    // 401 (no credits) and 404 (page does not exist) mean there is definitively
    // nothing to read on either endpoint — don't manufacture a row out of whatever
    // generic content a "successful" scrape of a dead/blocked URL happens to return.
    if (!isRetryableFailure(extractErr)) {
      return fail(describeError(extractErr));
    }
    try {
      // Tier 1 already scraped this URL in the common case; `cached` makes the
      // repeat call free, and re-entering it here keeps the path correct when
      // tier 1 was the thing that failed.
      const { value: markdown, cached: wasCached } =
        scrapedMarkdown !== undefined
          ? { value: scrapedMarkdown, cached: true }
          : await cached(cacheKeyForScrape(source.url), DEFAULT_TTL_MS, () => scrapeMarkdown(source.url));
      if (!isSubstantiveMarkdown(markdown)) {
        throw new Error("scraped page had no substantive content to fall back on");
      }
      const heuristicRecord = heuristicExtract(markdown, fields);
      if (!hasAnyValue(heuristicRecord)) {
        throw new Error("heuristic fallback matched none of the requested fields on the scraped page");
      }
      const ms = nowMs() - start;
      console.info(
        `[research] ${source.url}: extract path unavailable (${describeError(extractErr)}), ` +
          `used heuristic fallback over scraped markdown`,
      );
      safeHook(hooks?.onSourceRead, source.id, ms, wasCached);
      const record: DataRecord = { ...heuristicRecord, _source: source.id };
      const title = titleFromMarkdown(markdown) ?? source.title;
      const updatedSource: Source = { ...source, title, fetchedAt: new Date().toISOString() };
      return { source: updatedSource, records: [record] };
    } catch (scrapeErr) {
      return fail(describeError(scrapeErr));
    }
  }
}

// ---------------------------------------------------------------------------
// Brand enrichment — best-effort, fire-and-forget. Never awaited by the
// caller and never allowed to fail the run.
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
  const datasetId = shortId("ds_");
  const label = "Reading sources";
  const total = params.seedUrls.length;

  const sources: Source[] = params.seedUrls.map((url) => ({
    id: shortId("src_"),
    url,
    title: titleFromUrl(url),
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
    fields: params.fields,
    records: [],
    findings: [],
  };
  useLoom.getState().addDataset(initialDataset);
  safeHook(hooks?.onStart, datasetId, sources);

  // Best-effort, non-blocking — never awaited on the critical path.
  void enrichBrandsInBackground(datasetId, sources);

  let done = 0;
  let allRecords: DataRecord[] = [];
  const updatedSources: Source[] = [...sources];

  const tasks = sources.map((source, i) =>
    processSource(source, params.fields, params.question, undefined, hooks).then((result) => {
      done += 1;
      updatedSources[i] = result.source;
      allRecords = allRecords.concat(result.records);
      safeHook(hooks?.onProgress, done, total, label);
      useLoom.getState().upsertDataset(datasetId, { sources: [...updatedSources], records: [...allRecords] });
      return result;
    }),
  );

  await Promise.allSettled(tasks);

  // Preserve any brand data that already landed via the background enrichment
  // above before we overwrite the dataset with the final assembly.
  const liveSources = useLoom.getState().datasets[datasetId]?.sources ?? updatedSources;
  const sourcesWithBrand = updatedSources.map((s) => {
    const withBrand = liveSources.find((ls) => ls.id === s.id);
    return withBrand?.brand ? { ...s, brand: withBrand.brand } : s;
  });

  const findings = generateFindings(allRecords, params.fields, sourcesWithBrand);
  const headline = generateHeadline(params.question, allRecords, sourcesWithBrand, params.fields);

  const finalDataset: Dataset = {
    id: datasetId,
    question: params.question,
    headline,
    createdAt,
    sources: sourcesWithBrand,
    fields: params.fields,
    records: allRecords,
    findings,
  };
  useLoom.getState().addDataset(finalDataset);
  registerSources(sourcesWithBrand);

  return buildSummary(finalDataset);
}

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

  // Deepen used to mint a fresh dataset id for the merged result. Nothing on the
  // canvas pointed at that id, so the new rows were invisible until the agent
  // re-rendered — which replaced the whole dashboard and made every chart remount.
  // Updating the existing dataset in place is what "extend" should mean: components
  // bound to this id pick the new rows up on the next render, nothing remounts, and
  // the agent has no second id to misremember.
  const label = `Deepening: ${params.angle}`;
  const total = existing.sources.length;

  for (const s of existing.sources) safeHook(hooks?.onSourceFound, s);
  safeHook(hooks?.onProgress, 0, total, label);

  let done = 0;
  let newRecords: DataRecord[] = [];
  const updatedSources: Source[] = [...existing.sources];

  const tasks = existing.sources.map((source, i) =>
    processSource(source, existing.fields, existing.question, params.angle, hooks).then((result) => {
      done += 1;
      updatedSources[i] = result.source;
      newRecords = newRecords.concat(result.records);
      safeHook(hooks?.onProgress, done, total, label);
      useLoom.getState().upsertDataset(params.datasetId, {
        sources: [...updatedSources],
        records: existing.records.concat(newRecords),
      });
      return result;
    }),
  );

  await Promise.allSettled(tasks);

  const mergedRecords = existing.records.concat(newRecords);
  const findings = generateFindings(mergedRecords, existing.fields, updatedSources);
  const headline = generateHeadline(existing.question, mergedRecords, updatedSources, existing.fields);

  const finalDataset: Dataset = {
    ...existing,
    headline,
    sources: updatedSources,
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

export function getDataset(id: string): Dataset | undefined {
  return useLoom.getState().datasets[id];
}
