import { z } from "zod";
import { ComponentKind } from "./ui.js";

/**
 * A report template is a *layout recipe*, never a copied report.
 *
 * The whole value of saving a template is reusing it on an unrelated subject: a
 * layout captured from a pricing comparison should work for restaurants. That only
 * holds if nothing subject-specific survives capture — no dataset ids, no field
 * keys, no URLs, no values, no findings text. Everything below is deliberately
 * data-independent, and `assertNoDataBindings` is the enforcement.
 *
 * Stored in `localStorage` only (see `templates/storage.ts`), versioned so a future
 * shape change can reject old entries instead of misreading them.
 */

export const TEMPLATE_VERSION = 1;

export const TEMPLATE_LIMITS = {
  maxSlots: 10,
  maxTemplates: 30,
  maxNameLength: 60,
  /** Dynamic variables ride along with every session start; keep the payload small. */
  maxContextChars: 2000,
} as const;

/**
 * Presentation options that mean something without knowing the data.
 *
 * `chartKind` is safe: "show this as a pie" is a layout decision. A chart's `x`/`y`
 * are NOT here — those are field keys, which is exactly the domain leakage that
 * would stop a pricing template working for restaurants.
 */
export const TemplateSlotOptions = z.object({
  chartKind: z.enum(["bar", "line", "pie"]).optional(),
  /** Whether a chart shows its legend. A display choice, not a data one. */
  legend: z.enum(["auto", "show", "hide"]).optional(),
  /** How many columns a table shows, not which ones. */
  maxColumns: z.number().int().min(1).max(12).optional(),
});
export type TemplateSlotOptions = z.infer<typeof TemplateSlotOptions>;

export const TemplateSlot = z.object({
  /** Unique within a template; used for stable React keys and error reporting. */
  slotId: z.string().min(1),
  kind: ComponentKind,
  /** Position in the report, ascending. */
  order: z.number().int().min(0),
  /** Columns out of 12. Omitted means "use the default span for this kind". */
  columnSpan: z.number().int().min(1).max(12).optional(),
  title: z.string().max(80).optional(),
  options: TemplateSlotOptions.optional(),
});
export type TemplateSlot = z.infer<typeof TemplateSlot>;

export const ReportTemplate = z
  .object({
    version: z.literal(TEMPLATE_VERSION),
    id: z.string().min(1),
    name: z.string().min(1).max(TEMPLATE_LIMITS.maxNameLength),
    createdAt: z.string(),
    updatedAt: z.string(),
    columns: z.literal(12).default(12),
    slots: z.array(TemplateSlot).min(1).max(TEMPLATE_LIMITS.maxSlots),
  })
  .refine((t) => new Set(t.slots.map((s) => s.slotId)).size === t.slots.length, {
    message: "slotId must be unique within a template",
    path: ["slots"],
  });
export type ReportTemplate = z.infer<typeof ReportTemplate>;

/** What actually reaches ElevenLabs as a dynamic variable — smaller still. */
export const TemplateSessionContext = z.object({
  name: z.string(),
  slots: z.array(
    z.object({
      kind: ComponentKind,
      title: z.string().optional(),
      chartKind: z.enum(["bar", "line", "pie"]).optional(),
    }),
  ),
});
export type TemplateSessionContext = z.infer<typeof TemplateSessionContext>;

/** The literal string sent when the user has selected no template. */
export const NO_TEMPLATE_CONTEXT = "NONE";

/**
 * Keys that must never appear anywhere inside a stored template.
 *
 * Capture strips them, but a hand-edited `localStorage` entry or a future refactor
 * could reintroduce one, and a template carrying `datasetId` would silently bind a
 * new report to a dead dataset. Cheap to check, so check it on the way in and out.
 */
const FORBIDDEN_KEYS = ["datasetId", "columns_", "filters", "highlights", "items", "sort", "x", "y", "url", "sourceIds"];

export function assertNoDataBindings(value: unknown, path = "template"): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoDataBindings(v, `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // `columns` on the template root is a grid width (12), not a list of field keys.
    if (key === "columns" && typeof child === "number") continue;
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`${path}.${key} is data-bound and cannot be stored in a template`);
    }
    assertNoDataBindings(child, `${path}.${key}`);
  }
}

/** Compact the template down to what the agent needs to know about it. */
export function toSessionContext(template: ReportTemplate): TemplateSessionContext {
  return {
    name: template.name,
    slots: [...template.slots]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({
        kind: s.kind,
        ...(s.title ? { title: s.title } : {}),
        ...(s.options?.chartKind ? { chartKind: s.options.chartKind } : {}),
      })),
  };
}

/**
 * Serialize for `dynamicVariables`. Returns `NONE` for no template, and falls back
 * to `NONE` rather than sending a truncated half-object if a pathological template
 * somehow exceeds the size cap — a malformed recipe is worse than no recipe.
 */
export function serializeTemplateContext(template: ReportTemplate | null): string {
  if (!template) return NO_TEMPLATE_CONTEXT;
  const json = JSON.stringify(toSessionContext(template));
  return json.length <= TEMPLATE_LIMITS.maxContextChars ? json : NO_TEMPLATE_CONTEXT;
}
