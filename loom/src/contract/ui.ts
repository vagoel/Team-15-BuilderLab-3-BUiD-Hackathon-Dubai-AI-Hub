import { z } from "zod";

/**
 * Declarative generative UI (PLAN.md §4).
 *
 * The agent composes layouts freely, but only ever out of components we wrote and
 * styled. A spec that fails this schema never reaches the renderer.
 */

export const FilterOp = z.enum(["lt", "lte", "gt", "gte", "eq", "neq", "contains"]);
export type FilterOp = z.infer<typeof FilterOp>;

/**
 * `value` is deliberately forgiving.
 *
 * We can only describe it to the model as one JSON type, and models improvise around
 * scalars anyway — wrapping them (`{ value: "Drift" }`), sending a one-item array, or
 * sending a boolean. Rejecting those produced three straight `set_filter` failures in
 * a real session, so unwrap the obvious shapes instead. `applyFilters` already parses
 * numerics out of strings, so a string is always a safe landing place.
 */
const FilterValue = z.preprocess((raw) => {
  let v = raw;
  if (Array.isArray(v)) v = v.length === 1 ? v[0] : v.join(",");
  if (v && typeof v === "object") {
    const inner = Object.values(v as Record<string, unknown>).find(
      (x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean",
    );
    v = inner ?? "";
  }
  if (typeof v === "boolean") v = String(v);
  return v;
}, z.union([z.string(), z.number()]));

export const Filter = z.object({
  field: z.string(),
  op: FilterOp,
  value: FilterValue,
});
export type Filter = z.infer<typeof Filter>;

export const Sort = z.object({
  field: z.string(),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

const base = {
  id: z.string().describe("Stable id you will reuse to update this component later."),
  title: z.string().optional(),
};

export const StatCardsSpec = z.object({
  ...base,
  type: z.literal("stat_cards"),
  items: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        delta: z.string().optional(),
        hint: z.string().optional(),
      }),
    )
    .max(4),
});

export const ComparisonTableSpec = z.object({
  ...base,
  type: z.literal("comparison_table"),
  datasetId: z.string(),
  columns: z.array(z.string()).describe("Field keys from the dataset, in display order."),
  sort: Sort.optional(),
  filters: z.array(Filter).default([]),
  /**
   * Marks rows without removing them. Filtering answers "show me only X"; this
   * answers "which ones are X?" — the whole table stays on screen and the matches
   * light up while the agent talks about them. A row matching ANY highlight is marked.
   */
  highlights: z.array(Filter).default([]),
});

export const ChartSpec = z.object({
  ...base,
  type: z.literal("chart"),
  datasetId: z.string(),
  kind: z.enum(["bar", "line", "pie"]),
  x: z.string().describe("Field key for the category axis. For a pie, the slice labels."),
  y: z
    .array(z.string())
    .min(1)
    .describe("Numeric field keys to plot. A pie uses only the first, summed per category."),
  filters: z.array(Filter).default([]),
});

export const SourceListSpec = z.object({
  ...base,
  type: z.literal("source_list"),
  datasetId: z.string(),
});

export const FindingsSpec = z.object({
  ...base,
  type: z.literal("findings"),
  datasetId: z.string().optional(),
  items: z
    .array(z.object({ text: z.string(), sourceIds: z.array(z.string()).default([]) }))
    .optional()
    .describe("Omit to use the dataset's own findings."),
});

export const UiComponentSpec = z.discriminatedUnion("type", [
  StatCardsSpec,
  ComparisonTableSpec,
  ChartSpec,
  SourceListSpec,
  FindingsSpec,
]);
export type UiComponentSpec = z.infer<typeof UiComponentSpec>;

export const UiSpec = z.object({
  title: z.string().optional(),
  layout: z.enum(["stack", "grid"]).default("grid"),
  components: z.array(UiComponentSpec).min(1).max(10),
});
export type UiSpec = z.infer<typeof UiSpec>;

/** Shape reported back by `get_ui_state` so the agent can see what is on screen. */
export const UiState = z.object({
  title: z.string().optional(),
  components: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string().optional(),
      datasetId: z.string().optional(),
      visibleRows: z.number().optional(),
      filters: z.array(Filter).optional(),
    }),
  ),
});
export type UiState = z.infer<typeof UiState>;

export const COMPONENT_TYPES = [
  "stat_cards",
  "comparison_table",
  "chart",
  "source_list",
  "findings",
] as const;

export const ComponentKind = z.enum(COMPONENT_TYPES);
export type ComponentKind = z.infer<typeof ComponentKind>;
