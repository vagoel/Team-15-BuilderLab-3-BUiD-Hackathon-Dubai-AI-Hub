import type { DataRecord, FieldSpec } from "../contract/dataset.js";

/**
 * Thin typed client for the context.dev API.
 *
 * Every call goes to the same-origin Vite dev proxy at `/api/context/*` (see
 * vite.config.ts), which injects the Authorization header server-side. This file
 * never sees, sends, or logs an API key.
 *
 * Request/response shapes below were confirmed empirically against the live API
 * (curl, with the real key, ahead of build time) — not guessed from docs alone:
 *
 *   GET  /v1/web/scrape/markdown?url=<encoded>
 *     -> 200 { success: true, markdown: string }
 *
 *   POST /v1/web/extract   body: { url, schema, instructions?, maxPages? }
 *     -> 200 { status: "ok", url, urls_analyzed: string[], data: <shape of `schema`>, metadata: {...} }
 *     -> 400 { message: [...], error_code: "INPUT_VALIDATION_ERROR" }
 *     We ask for `schema = { records: [...] }` (an array wrapper) so one page can
 *     yield many rows; the API honours it and returns `data.records` as an array.
 *
 *   POST /v1/brand/retrieve   body: { type: "by_domain", domain }
 *     -> 200 { status: "ok", brand: { title, colors: [{hex,name}], logos: [{url,mode,...}], ... } }
 *     -> 400 { message: [...], status: "error", error_code: "INPUT_VALIDATION_ERROR" }
 *
 * This is the real, live extraction path — not the heuristic fallback. See
 * pipeline.ts for the fallback that kicks in only if a call here fails or comes
 * back in an unexpected shape.
 */

// Scrape and brand calls are fast in practice (3.39s cold / 0.90s warm for scrape,
// per PLAN.md measurements), so the shorter default is generous for them.
const DEFAULT_TIMEOUT_MS = 25_000;
// /web/extract is measured at ~22s per URL against the real API. The old shared
// 20s budget aborted every single real extraction before it could finish, silently
// downgrading every research call to the heuristic markdown fallback — this was the
// single biggest risk to tomorrow's demo. Give it comfortable headroom above the
// measured worst case for stage network variance.
const EXTRACT_TIMEOUT_MS = 45_000;
const BASE = "/api/context/v1";

export class ContextApiError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  readonly endpoint: string;

  constructor(status: number, bodySnippet: string, endpoint: string) {
    super(`context.dev ${endpoint} failed (status ${status}): ${bodySnippet}`);
    this.name = "ContextApiError";
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.endpoint = endpoint;
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

async function requestJson(
  endpoint: string,
  input: { method: "GET" | "POST"; url: string; body?: unknown },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
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
    if (!res.ok) throw new ContextApiError(res.status, snippet(text), endpoint);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ContextApiError(res.status, snippet(text), endpoint);
    }
  } finally {
    clearTimeout(timer);
  }
}

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

function jsonSchemaTypeFor(field: FieldSpec): { type: string[]; description: string } {
  switch (field.type) {
    case "number":
      return { type: ["number", "null"], description: field.label };
    case "currency":
      return {
        type: ["number", "null"],
        description:
          `${field.label} — numeric value only` +
          (field.unit ? ` in ${field.unit}` : "") +
          ", no currency symbols, commas, or ranges",
      };
    case "date":
      return {
        type: ["string", "null"],
        description: `${field.label} — an ISO 8601 date (YYYY-MM-DD) if possible`,
      };
    case "url":
      return { type: ["string", "null"], description: `${field.label} — a URL` };
    case "string":
    default:
      return { type: ["string", "null"], description: field.label };
  }
}

function buildExtractSchema(fields: FieldSpec[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of fields) properties[field.key] = jsonSchemaTypeFor(field);
  return {
    type: "object",
    properties: {
      records: {
        type: "array",
        description: "One entry per distinct row or item on the page that matches the requested fields.",
        items: { type: "object", properties, additionalProperties: false },
      },
    },
    required: ["records"],
    additionalProperties: false,
  };
}

function toDataRecord(raw: Record<string, unknown>, fields: FieldSpec[]): DataRecord {
  const out: DataRecord = {};
  for (const field of fields) {
    const value = raw[field.key];
    out[field.key] = typeof value === "string" || typeof value === "number" ? value : null;
  }
  return out;
}

/**
 * Structured extraction for one URL against a caller-supplied field schema.
 * Returns one DataRecord per row/item the API found (may be empty).
 */
export async function extractStructured(
  url: string,
  fields: FieldSpec[],
  instructions?: string,
): Promise<DataRecord[]> {
  const endpoint = "/web/extract";
  const body = {
    url,
    schema: buildExtractSchema(fields),
    // Be emphatic about exhaustiveness. Asked politely, the API returns a tidy
    // summary of a handful of rows; asked like this, the same page yields dozens.
    // Row count is the difference between a real table and a toy one.
    instructions:
      instructions ??
      "Extract EVERY distinct row, item, plan, tier or entry on this page that matches " +
        "the requested fields — be exhaustive, not representative. A page listing forty " +
        "items must return forty records. Do not summarise, group, deduplicate or stop " +
        "early. One record per row exactly as it appears. Use null for any field not " +
        "present on that row. Never invent data.",
    maxPages: 1,
  };
  const json = await requestJson(endpoint, { method: "POST", url: `${BASE}${endpoint}`, body }, EXTRACT_TIMEOUT_MS);
  if (!isRecord(json) || json.status !== "ok" || !isRecord(json.data)) {
    throw new ContextApiError(200, describeUnexpected(json), endpoint);
  }
  const { records } = json.data;
  if (Array.isArray(records)) {
    return records.filter(isRecord).map((r) => toDataRecord(r, fields));
  }
  // The model occasionally returns the fields directly, without the array wrapper.
  // Salvage it as a single row rather than treating it as a failure — but only if it
  // actually carries a value. An all-null salvage record is indistinguishable from
  // "found nothing" and must not be counted as an extracted row upstream, or a
  // completely empty response silently inflates the record count.
  const salvaged = toDataRecord(json.data, fields);
  const hasValue = Object.values(salvaged).some((v) => v !== null);
  return hasValue ? [salvaged] : [];
}

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

  const name = typeof brand.title === "string" ? brand.title : undefined;

  const logos = Array.isArray(brand.logos) ? brand.logos.filter(isRecord) : [];
  const firstLogo = logos[0];
  const logoUrl = firstLogo && typeof firstLogo.url === "string" ? firstLogo.url : undefined;

  const colors = Array.isArray(brand.colors) ? brand.colors.filter(isRecord) : [];
  const firstColor = colors[0];
  const color = firstColor && typeof firstColor.hex === "string" ? firstColor.hex : undefined;

  return { name, logoUrl, color };
}
