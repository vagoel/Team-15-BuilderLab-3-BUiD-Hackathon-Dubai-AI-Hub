import { describe, expect, it } from "vitest";
import type { Dataset } from "../contract/index.js";
import { buildLayout, chooseLayout, defaultLayout } from "./autoLayout.js";

function dataset(over: Partial<Dataset> = {}): Dataset {
  return {
    id: "ds_1",
    question: "Compare pricing",
    headline: "",
    createdAt: new Date().toISOString(),
    sources: [{ id: "s1", url: "https://example.com/pricing", title: "Example" }],
    fields: [
      { key: "vendor", label: "Vendor", type: "string" },
      { key: "context_k", label: "Context", type: "number" },
      { key: "price", label: "Price", type: "currency", unit: "$" },
    ],
    records: [
      { vendor: "A", context_k: 8, price: 3, _source: "s1" },
      { vendor: "B", context_k: 128, price: 9, _source: "s1" },
      { vendor: "C", context_k: 32, price: 6, _source: "s1" },
    ],
    findings: [{ text: "A is cheapest", sourceIds: ["s1"] }],
    ...over,
  };
}

describe("buildLayout", () => {
  it("charts the money column, not whichever number came first", () => {
    // The agent lists fields in whatever order it thought of them. `context_k` is
    // declared before `price` here; charting it would be valid and useless.
    const spec = buildLayout(dataset(), ["chart"]);
    const chart = spec.components[0];
    expect(chart?.type).toBe("chart");
    if (chart?.type === "chart") {
      expect(chart.y).toEqual(["price"]);
      expect(chart.x).toBe("vendor");
    }
  });

  it("drops a chart it cannot build rather than mounting it broken", () => {
    const textOnly = dataset({
      fields: [
        { key: "vendor", label: "Vendor", type: "string" },
        { key: "note", label: "Note", type: "string" },
      ],
      records: [{ vendor: "A", note: "x", _source: "s1" }],
    });

    const spec = buildLayout(textOnly, ["chart", "comparison_table"]);
    expect(spec.components.map((c) => c.type)).toEqual(["comparison_table"]);
  });

  it("never returns an empty dashboard", () => {
    // Sources always exist, so the source list is the floor.
    const empty = dataset({ fields: [], records: [], findings: [] });
    const spec = buildLayout(empty, ["chart", "findings"]);
    expect(spec.components.length).toBeGreaterThan(0);
    expect(spec.components[0]?.type).toBe("source_list");
  });

  it("ignores duplicate component requests and respects the six-component cap", () => {
    const spec = buildLayout(dataset(), [
      "chart",
      "chart",
      "comparison_table",
      "comparison_table",
      "stat_cards",
    ]);
    expect(spec.components.map((c) => c.type)).toEqual(["chart", "comparison_table", "stat_cards"]);
  });

  it("keeps the internal _source column out of the table", () => {
    const spec = buildLayout(dataset(), ["comparison_table"]);
    const table = spec.components[0];
    if (table?.type === "comparison_table") {
      expect(table.columns).not.toContain("_source");
    }
  });

  it("gives auto-built components the stable ids the agent is told to target", () => {
    // The system prompt names these directly, so update_component and set_filter can
    // address them without a get_ui_state round-trip.
    const spec = defaultLayout(dataset());
    const ids = spec.components.map((c) => c.id);
    expect(ids).toContain("auto_chart");
    expect(ids).toContain("auto_table");
    expect(ids.every((id) => id.startsWith("auto_"))).toBe(true);
  });

  it("summarises row count, cardinality and numeric spread in the stat cards", () => {
    const spec = buildLayout(dataset(), ["stat_cards"]);
    const stats = spec.components[0];
    expect(stats?.type).toBe("stat_cards");
    if (stats?.type === "stat_cards") {
      expect(stats.items.length).toBeLessThanOrEqual(4);
      expect(stats.items[0]?.value).toBe("3");
      // How many distinct things are being compared, then the money.
      expect(stats.items[1]).toMatchObject({ label: "Vendors", value: "3" });
      expect(stats.items.map((i) => i.label)).toContain("Price");
    }
  });

  it("picks a layout preset from what the data produced", () => {
    // A full research result (4+ cards) packs into masonry; a chart-or-table result
    // with three cards spotlights it in focus; two or fewer just stack.
    expect(defaultLayout(dataset()).layout).toBe("masonry");
    expect(buildLayout(dataset(), ["stat_cards", "chart", "findings"]).layout).toBe("focus");
    expect(buildLayout(dataset(), ["chart"]).layout).toBe("stack");
  });

  it("chooseLayout falls back to grid when nothing carries a chart or table", () => {
    const spec = buildLayout(dataset(), ["stat_cards", "findings", "source_list"]);
    expect(chooseLayout(spec.components)).toBe("grid");
  });

  it("omits the cardinality card when every row is the same category", () => {
    const oneVendor = dataset({
      records: [
        { vendor: "A", context_k: 8, price: 3, _source: "s1" },
        { vendor: "A", context_k: 16, price: 5, _source: "s1" },
      ],
    });
    const spec = buildLayout(oneVendor, ["stat_cards"]);
    const stats = spec.components[0];
    if (stats?.type === "stat_cards") {
      expect(stats.items.map((i) => i.label)).not.toContain("Vendors");
    }
  });
});
