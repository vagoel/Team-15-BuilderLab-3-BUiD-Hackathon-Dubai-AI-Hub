import { beforeEach, describe, expect, it } from "vitest";
import { useLoom } from "./store.js";

beforeEach(() => useLoom.getState().reset());

describe("report preview state", () => {
  it("requires a canvas and records print requests only while open", () => {
    expect(useLoom.getState().openReportPreview()).toBe(false);
    expect(useLoom.getState().requestReportPrint()).toBe(false);
    useLoom.getState().setSpec({
      layout: "grid",
      components: [{ id: "stats", type: "stat_cards", items: [{ label: "Rows", value: "3" }] }],
    });
    expect(useLoom.getState().openReportPreview()).toBe(true);
    expect(useLoom.getState().reportPreview.openedAt).toEqual(expect.any(Number));
    expect(useLoom.getState().requestReportPrint()).toBe(true);
    expect(useLoom.getState().reportPreview.printRequestId).toBe(1);
    useLoom.getState().closeReportPreview();
    expect(useLoom.getState().requestReportPrint()).toBe(false);
  });

  it("clears report and table view state with the canvas", () => {
    useLoom.getState().setSpec({
      layout: "grid",
      components: [{ id: "table", type: "comparison_table", datasetId: "one", columns: ["name"], filters: [], highlights: [] }],
    });
    useLoom.getState().setTableViewFilters("table", "one", [{ field: "name", op: "contains", value: "A" }]);
    useLoom.getState().openReportPreview();
    expect(useLoom.getState().clearCanvas()).toBe(true);
    expect(useLoom.getState().tableViewFilters).toEqual({});
    expect(useLoom.getState().reportPreview.open).toBe(false);
  });
});

describe("manual table filters", () => {
  it("includes only matching dataset-scoped filters in visible row counts", () => {
    useLoom.getState().addDataset({
      id: "one",
      question: "Question",
      headline: "Headline",
      createdAt: "2025-01-01T00:00:00Z",
      sources: [],
      fields: [{ key: "name", label: "Name", type: "string" }],
      records: [{ name: "Alpha" }, { name: "Beta" }],
      findings: [],
    });
    useLoom.getState().setSpec({
      layout: "grid",
      components: [{ id: "table", type: "comparison_table", datasetId: "one", columns: ["name"], filters: [], highlights: [] }],
    });
    useLoom.getState().setTableViewFilters("table", "one", [{ field: "name", op: "contains", value: "Al" }]);
    expect(useLoom.getState().getUiState().components[0]?.visibleRows).toBe(1);
    useLoom.getState().setTableViewFilters("table", "old", [{ field: "name", op: "contains", value: "none" }]);
    expect(useLoom.getState().getUiState().components[0]?.visibleRows).toBe(2);
  });
});
