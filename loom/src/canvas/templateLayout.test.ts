import { describe, expect, it } from "vitest";
import type { Dataset, ReportTemplate } from "../contract/index.js";
import { applyTemplate } from "./templateLayout.js";
import { defaultLayout } from "./autoLayout.js";

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: "ds_1",
    question: "Where should we eat?",
    headline: "12 rows",
    createdAt: new Date().toISOString(),
    sources: [{ id: "src_1", url: "https://a.test", title: "A", fetchedAt: new Date().toISOString() }],
    fields: [
      { key: "restaurant", label: "Restaurant", type: "string" },
      { key: "price", label: "Price", type: "currency", unit: "AED" },
    ],
    records: [
      { restaurant: "Aubaine", price: 180, _source: "src_1" },
      { restaurant: "Reif", price: 95, _source: "src_1" },
    ],
    findings: [{ text: "Two places under 200.", sourceIds: [] }],
    ...overrides,
  };
}

const PRICING_TEMPLATE: ReportTemplate = {
  version: 1,
  id: "tpl_1",
  name: "Comparison layout",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  columns: 12,
  slots: [
    { slotId: "stats_1", kind: "stat_cards", order: 0, columnSpan: 12 },
    { slotId: "chart_1", kind: "chart", order: 1, columnSpan: 5, options: { chartKind: "pie" } },
    { slotId: "table_1", kind: "comparison_table", order: 2, columnSpan: 7, options: { maxColumns: 1 } },
  ],
};

describe("applyTemplate", () => {
  it("reuses a layout saved from one subject on a completely different one", () => {
    // The template came from a pricing report; this dataset is restaurants. Nothing
    // about the original subject may leak through.
    const { spec } = applyTemplate(dataset(), PRICING_TEMPLATE);

    expect(spec.components.map((c) => c.type)).toEqual(["stat_cards", "chart", "comparison_table"]);
    const table = spec.components.find((c) => c.type === "comparison_table");
    if (table?.type === "comparison_table") expect(table.columns).toEqual(["restaurant"]);
    const chart = spec.components.find((c) => c.type === "chart");
    if (chart?.type === "chart") {
      expect(chart.kind).toBe("pie");
      // Axes are rebuilt from THIS dataset, never remembered from the old one.
      expect(chart.y).toEqual(["price"]);
    }
  });

  it("carries a saved legend choice, which is presentation, not data", () => {
    const withLegend: ReportTemplate = {
      ...PRICING_TEMPLATE,
      slots: [{ slotId: "chart_1", kind: "chart", order: 0, options: { chartKind: "bar", legend: "show" } }],
    };
    const chart = applyTemplate(dataset(), withLegend).spec.components[0];
    if (chart?.type === "chart") expect(chart.legend).toBe("show");
  });

  it("carries slot spans onto the components", () => {
    const { spec } = applyTemplate(dataset(), PRICING_TEMPLATE);
    expect(spec.components.map((c) => c.columnSpan)).toEqual([12, 5, 7]);
  });

  it("omits a slot this data cannot fill, and reports which", () => {
    // No numeric column, so no chart is possible. Mounting an empty card would read
    // as a bug; silently dropping it would let the agent describe a chart that is
    // not there. So: omit it and say so.
    const prose = dataset({ records: [], fields: [{ key: "name", label: "Name", type: "string" }] });
    const { spec, omitted } = applyTemplate(prose, PRICING_TEMPLATE);

    expect(omitted).toContain("chart");
    expect(spec.components.some((c) => c.type === "chart")).toBe(false);
  });

  it("never returns an empty canvas", () => {
    const empty = dataset({ records: [], fields: [], findings: [] });
    const onlyCharts: ReportTemplate = { ...PRICING_TEMPLATE, slots: [PRICING_TEMPLATE.slots[1]!] };
    const { spec } = applyTemplate(empty, onlyCharts);
    expect(spec.components.length).toBeGreaterThan(0);
  });

  it("gives slot components distinct ids so two of a kind can coexist", () => {
    const twoTables: ReportTemplate = {
      ...PRICING_TEMPLATE,
      slots: [
        { slotId: "table_a", kind: "comparison_table", order: 0 },
        { slotId: "table_b", kind: "comparison_table", order: 1 },
      ],
    };
    const { spec } = applyTemplate(dataset(), twoTables);
    const ids = spec.components.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("honours slot order rather than the order they happen to be listed in", () => {
    const reversed: ReportTemplate = {
      ...PRICING_TEMPLATE,
      slots: [
        { slotId: "table_1", kind: "comparison_table", order: 2 },
        { slotId: "stats_1", kind: "stat_cards", order: 0 },
        { slotId: "chart_1", kind: "chart", order: 1 },
      ],
    };
    const { spec } = applyTemplate(dataset(), reversed);
    expect(spec.components.map((c) => c.type)).toEqual(["stat_cards", "chart", "comparison_table"]);
  });
});

describe("defaultLayout — the no-template path", () => {
  it("builds the full dashboard when there are rows", () => {
    const types = defaultLayout(dataset()).components.map((c) => c.type);
    expect(types).toContain("comparison_table");
    expect(types).toContain("chart");
  });

  it("leads with findings and sources when the pages were prose", () => {
    // A stat card counting to zero and an empty table are not a report. What the
    // reader actually has is the sources and what was read on them.
    const prose = dataset({ records: [], fields: [] });
    const types = defaultLayout(prose).components.map((c) => c.type);

    expect(types).not.toContain("comparison_table");
    expect(types).not.toContain("chart");
    expect(types).toContain("source_list");
  });

  it("adds a gallery when images were collected", () => {
    const withImages = dataset({ images: [{ src: "https://cdn.test/a.png", sourceId: "src_1" }] });
    expect(defaultLayout(withImages).components.map((c) => c.type)).toContain("image_gallery");
  });

  it("carries no explicit spans, so pre-template layouts are untouched", () => {
    expect(defaultLayout(dataset()).components.every((c) => c.columnSpan === undefined)).toBe(true);
  });
});
