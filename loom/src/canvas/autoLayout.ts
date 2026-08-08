import type { ComponentKind, Dataset, LayoutKind, UiComponentSpec, UiSpec } from "../contract/index.js";

/**
 * Build a dashboard from a dataset without asking the model for one.
 *
 * Composing a five-way discriminated union by hand turned out to be beyond the
 * agent: ElevenLabs' schema subset can't express the union, so the model only ever
 * saw an untyped object, guessed the shape, and looped on the same invalid spec.
 *
 * So the model no longer picks the shape — it picks the *intent* ("show me a chart
 * and a table") and this decides how that is expressed. It is also what runs
 * automatically the moment research finishes, so a dashboard appears whether or not
 * the agent ever calls render_ui.
 */

const NUMERIC = new Set(["number", "currency"]);

/**
 * Numeric columns, most chartable first.
 *
 * Field order in the dataset reflects the order the agent happened to list them, not
 * how interesting they are. A pricing dataset that declares `context_k` before
 * `input_per_m` would otherwise get a chart of context windows — technically valid,
 * completely beside the point. Money is almost always the answer the user came for,
 * so currency sorts ahead of plain numbers; identifier-ish columns sort last.
 */
function numericFields(dataset: Dataset) {
  const rank = (f: { key: string; type: string }) => {
    if (f.type === "currency") return 0;
    if (/^(id|index|rank|year|n|count_id)$/i.test(f.key)) return 2;
    return 1;
  };
  return dataset.fields.filter((f) => NUMERIC.has(f.type)).sort((a, b) => rank(a) - rank(b));
}

/** The best field to group by: prefer a low-cardinality text column. */
function categoryField(dataset: Dataset): string | undefined {
  const text = dataset.fields.filter((f) => !NUMERIC.has(f.type) && f.key !== "_source");
  let best: { key: string; distinct: number } | undefined;

  for (const f of text) {
    const distinct = new Set(dataset.records.map((r) => String(r[f.key] ?? ""))).size;
    if (distinct < 2) continue;
    if (!best || distinct < best.distinct) best = { key: f.key, distinct };
  }
  return best?.key ?? text[0]?.key;
}

function statCards(dataset: Dataset): UiComponentSpec | undefined {
  const items: Array<{ label: string; value: string; hint?: string }> = [
    {
      label: dataset.records.length === 1 ? "Record" : "Records",
      value: String(dataset.records.length),
      hint: `across ${dataset.sources.length} source${dataset.sources.length === 1 ? "" : "s"}`,
    },
  ];

  // How many distinct things are being compared is usually the second question
  // anyone asks, and it stops a two-column dataset leaving the stat row half empty.
  const category = categoryField(dataset);
  const categoryLabel = dataset.fields.find((f) => f.key === category)?.label;
  if (category && categoryLabel) {
    const distinct = new Set(
      dataset.records.map((r) => r[category]).filter((v) => v !== null && v !== undefined),
    ).size;
    if (distinct > 1) {
      items.push({ label: `${categoryLabel}s`, value: String(distinct), hint: "distinct values" });
    }
  }

  for (const f of numericFields(dataset).slice(0, 3)) {
    const values = dataset.records
      .map((r) => (typeof r[f.key] === "number" ? (r[f.key] as number) : Number(r[f.key])))
      .filter((n): n is number => Number.isFinite(n));
    if (!values.length) continue;

    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const unit = f.unit ? `${f.unit} ` : "";
    items.push({
      label: f.label,
      value: lo === hi ? `${unit}${fmt(lo)}` : `${unit}${fmt(lo)}–${fmt(hi)}`,
      hint: values.length < dataset.records.length ? `${values.length} with a value` : undefined,
    });
  }

  if (items.length === 0) return undefined;
  return { id: "auto_stats", type: "stat_cards", items: items.slice(0, 4) };
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n * 100) / 100);
}

export function buildComponent(
  dataset: Dataset,
  kind: ComponentKind,
  id?: string,
): UiComponentSpec | undefined {
  const built = build(dataset, kind);
  return built && id ? ({ ...built, id } as UiComponentSpec) : built;
}

function build(dataset: Dataset, kind: ComponentKind): UiComponentSpec | undefined {
  switch (kind) {
    case "stat_cards":
      return statCards(dataset);

    case "chart": {
      const x = categoryField(dataset);
      const y = numericFields(dataset)[0];
      if (!x || !y) return undefined; // nothing sensible to plot
      return {
        id: "auto_chart",
        type: "chart",
        title: `${y.label} by ${dataset.fields.find((f) => f.key === x)?.label ?? x}`,
        datasetId: dataset.id,
        kind: "bar",
        x,
        y: [y.key],
        filters: [],
      };
    }

    case "comparison_table": {
      const columns = dataset.fields.map((f) => f.key).filter((k) => k !== "_source");
      if (!columns.length) return undefined;
      return {
        id: "auto_table",
        type: "comparison_table",
        title: "All rows",
        datasetId: dataset.id,
        columns: columns.slice(0, 6),
        filters: [],
        highlights: [],
      };
    }

    case "source_list":
      return { id: "auto_sources", type: "source_list", title: "Sources", datasetId: dataset.id };

    case "findings":
      if (!dataset.findings.length) return undefined;
      return {
        id: "auto_findings",
        type: "findings",
        title: "What stood out",
        datasetId: dataset.id,
      };
  }
}

/**
 * Compose a spec from a dataset and a list of component kinds. Anything that cannot
 * be built from this dataset is dropped rather than mounted broken — a chart needs a
 * numeric column and a category to group by, and plenty of research has neither.
 */
export function buildLayout(
  dataset: Dataset,
  kinds: readonly ComponentKind[],
  title?: string,
  /**
   * Appended to every component id. A combined report holds components from more
   * than one dataset, and two tables both called `auto_table` would collide — the
   * agent could only ever address the first, and `patchComponent` would hit whichever
   * came first in the array.
   */
  idSuffix = "",
): UiSpec {
  const seen = new Set<ComponentKind>();
  const components: UiComponentSpec[] = [];

  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    const built = build(dataset, kind);
    if (built) components.push(idSuffix ? ({ ...built, id: `${built.id}${idSuffix}` } as UiComponentSpec) : built);
    if (components.length === 10) break;
  }

  // Never return an empty dashboard — the source list works for any dataset.
  if (!components.length) {
    components.push({
      id: "auto_sources",
      type: "source_list",
      title: "Sources",
      datasetId: dataset.id,
    });
  }

  return {
    title: title ?? dataset.question,
    layout: chooseLayout(components),
    components,
  };
}

/**
 * Pick the layout preset that suits what the data produced, rather than one shape
 * for everything. The user can switch presets afterwards — by voice (`set_layout`)
 * or the switcher pills — so this only has to be a good opening move.
 */
export function chooseLayout(components: readonly UiComponentSpec[]): LayoutKind {
  if (components.length <= 2) return "stack";
  if (components.length >= 4) return "masonry";
  const types = new Set(components.map((c) => c.type));
  if (types.has("chart") || types.has("comparison_table")) return "focus";
  return "grid";
}

/** What gets mounted automatically when research finishes. */
export function defaultLayout(dataset: Dataset): UiSpec {
  return buildLayout(dataset, ["stat_cards", "chart", "comparison_table", "findings", "source_list"]);
}
