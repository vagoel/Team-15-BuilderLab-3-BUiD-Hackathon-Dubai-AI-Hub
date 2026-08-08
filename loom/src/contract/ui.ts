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

/**
 * Per-component sizing, written by the drag handle and the `resize_component` voice
 * tool alike. `span` is a 12-column grid width (grid/focus layouts only — masonry
 * columns have a fixed width by construction); `height` is an explicit card height
 * in pixels, honoured by every layout.
 */
export const ComponentSize = z.object({
  span: z.number().int().min(1).max(12).optional(),
  height: z.number().min(120).max(1200).optional(),
});
export type ComponentSize = z.infer<typeof ComponentSize>;

const base = {
  id: z.string().describe("Stable id you will reuse to update this component later."),
  title: z.string().optional(),
  /**
   * One quiet line under the title. Where the title says what a card *is*, this
   * says what it shows — "Mean of 108 rows", "Filtered to under AED 200". Charts
   * already generate one when they aggregate; setting it here overrides that.
   */
  subtitle: z.string().optional(),
  /**
   * Explicit width out of 12, set when a template pins the placement. Left off by
   * adaptive layouts, which keep using the per-type spans in `Canvas`, so every
   * spec written before templates existed still renders exactly as it did.
   */
  columnSpan: z.number().int().min(1).max(12).optional(),
  /**
   * Grid geometry once the user has dragged or resized the card. `columnSpan` is
   * the template's opening request; this is where the layout actually ended up, so
   * it wins when both are present.
   */
  size: ComponentSize.optional(),
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
  /**
   * Axis titles. Both default to the field's own label at render time, so a chart
   * that says nothing about its axes is still readable — these exist for when the
   * field label is not the right words ("price" on an axis of AED per night).
   */
  xTitle: z.string().optional(),
  yTitle: z.string().optional(),
  /**
   * Omitted (or "auto") shows a legend when there is more than one series, and
   * always for a pie — a single-series bar chart is already explained by its y-axis
   * title, and a one-entry legend is furniture.
   *
   * Optional rather than `.default("auto")` deliberately: a zod default makes the
   * field *required* on the parsed output type, which would force every existing
   * chart-construction site to name it.
   */
  legend: z.enum(["auto", "show", "hide"]).optional(),
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

/**
 * Images scraped from the sources. Reads `dataset.images`, which carry their own
 * `sourceId` — an image with no attributable source is not shown, because the one
 * thing worse than no picture is a picture nobody can trace.
 */
export const ImageGallerySpec = z.object({
  ...base,
  type: z.literal("image_gallery"),
  datasetId: z.string(),
  max: z.number().int().min(1).max(48).optional(),
});

export const UiComponentSpec = z.discriminatedUnion("type", [
  StatCardsSpec,
  ComparisonTableSpec,
  ChartSpec,
  SourceListSpec,
  FindingsSpec,
  ImageGallerySpec,
]);
export type UiComponentSpec = z.infer<typeof UiComponentSpec>;

/**
 * The three presets the user can switch between (plus `stack`, which the app keeps
 * for provisional/tiny dashboards). `masonry` packs cards into columns by their
 * natural height; `focus` puts one primary artifact large with the rest in a rail;
 * `grid` is the structured 12-column layout.
 */
export const LayoutKind = z.enum(["stack", "grid", "masonry", "focus"]);
export type LayoutKind = z.infer<typeof LayoutKind>;

export const UiSpec = z.object({
  title: z.string().optional(),
  layout: LayoutKind.default("grid"),
  components: z.array(UiComponentSpec).min(1).max(10),
});
export type UiSpec = z.infer<typeof UiSpec>;

/** Shape reported back by `get_ui_state` so the agent can see what is on screen. */
export const UiState = z.object({
  title: z.string().optional(),
  layout: LayoutKind.optional(),
  components: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string().optional(),
      subtitle: z.string().optional(),
      datasetId: z.string().optional(),
      visibleRows: z.number().optional(),
      filters: z.array(Filter).optional(),
      size: ComponentSize.optional(),
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
  "image_gallery",
] as const;

export const ComponentKind = z.enum(COMPONENT_TYPES);
export type ComponentKind = z.infer<typeof ComponentKind>;
