import { ReportTemplate, TEMPLATE_LIMITS, assertNoDataBindings } from "../contract/index.js";

/**
 * Local-only template persistence.
 *
 * Every read is validated, never trusted: `localStorage` survives across builds, so
 * an entry written by an older shape, hand-edited, or half-written during a quota
 * failure will eventually be read back by newer code. Anything that fails validation
 * is dropped individually rather than taking the collection — or app startup — down
 * with it. Same defensive posture as `lib/theme.ts`.
 */

const TEMPLATES_KEY = "loom:templates:v1";
const SELECTED_KEY = "loom:templates:selected:v1";

export class TemplateStorageError extends Error {}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode or storage disabled entirely.
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota exceeded or storage unavailable. The caller keeps its in-memory copy
    // for this page's life, which is better than failing the user's save outright.
    throw new TemplateStorageError("could not save — browser storage is full or unavailable");
  }
}

/** Every valid stored template, newest first. Invalid entries are skipped. */
export function loadTemplates(): ReportTemplate[] {
  const raw = readRaw(TEMPLATES_KEY);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ReportTemplate[] = [];
  for (const entry of parsed) {
    // Audit the RAW entry, before zod sees it. Zod strips unknown keys, so parsing
    // first would quietly launder a stored `datasetId` out of existence and report
    // the entry as clean — which is the opposite of what this check is for.
    try {
      assertNoDataBindings(entry);
    } catch {
      continue; // Somebody stored a report. Don't load it back as a layout.
    }
    const result = ReportTemplate.safeParse(entry);
    if (!result.success) continue; // Wrong version, corrupt, or hand-edited.
    out.push(result.data);
  }
  return out.slice(0, TEMPLATE_LIMITS.maxTemplates);
}

export function saveTemplates(templates: ReportTemplate[]): void {
  const capped = templates.slice(0, TEMPLATE_LIMITS.maxTemplates);
  for (const template of capped) assertNoDataBindings(template);
  writeRaw(TEMPLATES_KEY, JSON.stringify(capped));
}

export function loadSelectedId(): string | null {
  const raw = readRaw(SELECTED_KEY);
  return raw && raw.length < 100 ? raw : null;
}

export function saveSelectedId(id: string | null): void {
  try {
    if (id) localStorage.setItem(SELECTED_KEY, id);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    // Selection still applies for this page; it just will not survive a reload.
  }
}
