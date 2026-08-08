import { describe, expect, it } from "vitest";
import type { Dataset, UiSpec } from "../contract/index.js";
import { buildReportModel, sanitizeFilename } from "./reportModel.js";

function dataset(id: string, sourceId = "source-1"): Dataset {
  return {
    id,
    question: "Question",
    headline: "Headline",
    createdAt: "2025-01-01T00:00:00Z",
    sources: [{ id: sourceId, title: `Source ${sourceId}`, url: `https://${sourceId}.example/report`, fetchedAt: "2025-01-01T00:00:00Z" }],
    fields: [
      { key: "name", label: "Name", type: "string" },
      { key: "price", label: "Price", type: "currency", unit: "AED" },
    ],
    records: [{ name: "Alpha", price: 300 }, { name: "Beta", price: 100 }, { name: "Alpine", price: 200 }],
    findings: [{ text: "Alpha is highest.", sourceIds: [sourceId] }],
  };
}

const spec: UiSpec = {
  title: "Price / Report",
  layout: "grid",
  components: [
    { id: "table", type: "comparison_table", datasetId: "one", columns: ["name", "price"], filters: [{ field: "price", op: "gte", value: 100 }], highlights: [{ field: "name", op: "eq", value: "Alpha" }], sort: { field: "price", dir: "asc" } },
    { id: "findings", type: "findings", datasetId: "one" },
    { id: "sources", type: "source_list", datasetId: "one" },
  ],
};

describe("buildReportModel", () => {
  it("preserves section order, combines filters, sorting, highlights, and all rows", () => {
    const model = buildReportModel(spec, { one: dataset("one") }, {
      table: { datasetId: "one", filters: [{ field: "name", op: "contains", value: "Al" }] },
    }, 1234);
    expect(model.sections.map((section) => section.type)).toEqual(["comparison_table", "findings", "source_list"]);
    const table = model.sections[0];
    expect(table?.type).toBe("comparison_table");
    if (table?.type === "comparison_table") {
      expect(table.rows.map((row) => row.record.price)).toEqual([200, 300]);
      expect(table.rows.map((row) => row.highlighted)).toEqual([false, true]);
      expect(table.summary).toContain("2 of 3 rows");
    }
    expect(model.rowCount).toBe(2);
    expect(model.sourceCount).toBe(1);
    expect(model.filename).toBe("Price-Report.pdf");
  });

  it("supports combined reports and de-duplicates repeated sources", () => {
    const combined: UiSpec = {
      layout: "stack",
      components: [
        ...spec.components,
        { id: "table-two", type: "comparison_table", datasetId: "two", columns: [], filters: [], highlights: [] },
      ],
    };
    const model = buildReportModel(combined, { one: dataset("one"), two: dataset("two") }, {}, 1);
    expect(model.datasetCount).toBe(2);
    expect(model.sourceCount).toBe(1);
    expect(model.rowCount).toBe(6);
  });

  it("returns an unavailable section rather than throwing for missing data", () => {
    const model = buildReportModel(spec, {}, {}, 1);
    const table = model.sections[0];
    expect(table?.type).toBe("comparison_table");
    if (table?.type === "comparison_table") expect(table.dataset).toBeUndefined();
    expect(model.rowCount).toBe(0);
  });

  it("ignores stale table filters from a previous dataset", () => {
    const model = buildReportModel(spec, { one: dataset("one") }, {
      table: { datasetId: "old", filters: [{ field: "name", op: "contains", value: "none" }] },
    }, 1);
    expect(model.rowCount).toBe(3);
  });
});

describe("sanitizeFilename", () => {
  it("produces a deterministic safe fallback", () => {
    expect(sanitizeFilename("  Résumé: Dubai / 2025  ")).toBe("Resume-Dubai-2025");
    expect(sanitizeFilename("***")).toBe("loom-research-report");
  });
});
