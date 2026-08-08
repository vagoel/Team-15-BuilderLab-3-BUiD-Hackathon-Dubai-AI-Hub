import { describe, expect, it } from "vitest";
import type { DataRecord } from "../contract/index.js";
import { applyFilters, formatValue } from "./filter.js";

const rows: DataRecord[] = [
  { product: "Drift", region: "EMEA", revenue: 28282, units: 155 },
  { product: "Atlas", region: "APAC", revenue: 125958, units: 152 },
  { product: "Drift", region: "APAC", revenue: 131228, units: 146 },
  { product: "Cobalt", region: "EMEA", revenue: 20648, units: 38 },
  { product: "Ember", region: "LATAM", revenue: null, units: 41 },
];

describe("applyFilters", () => {
  it("matches text equality on the text, not on a coerced number", () => {
    // Regression: stripping letters left "" and Number("") is 0, so every text cell
    // compared equal to every other and `product eq Drift` returned all five rows.
    const out = applyFilters(rows, [{ field: "product", op: "eq", value: "Drift" }]);
    expect(out.map((r) => r.revenue)).toEqual([28282, 131228]);
  });

  it("ignores case and stray whitespace, because nobody dictates exact casing", () => {
    const out = applyFilters(rows, [{ field: "product", op: "eq", value: "  drift " }]);
    expect(out).toHaveLength(2);
  });

  it("inverts cleanly on neq", () => {
    const out = applyFilters(rows, [{ field: "product", op: "neq", value: "Drift" }]);
    expect(out.map((r) => r.product)).toEqual(["Atlas", "Cobalt", "Ember"]);
  });

  it("compares numerically when both sides really are numbers", () => {
    const out = applyFilters(rows, [{ field: "revenue", op: "lt", value: 30000 }]);
    expect(out.map((r) => r.product)).toEqual(["Drift", "Cobalt"]);
  });

  it("accepts a number written as a string, since that is how it arrives by voice", () => {
    const out = applyFilters(rows, [{ field: "units", op: "gte", value: "150" }]);
    expect(out).toHaveLength(2);
  });

  it("drops rows with no value rather than treating null as zero", () => {
    const out = applyFilters(rows, [{ field: "revenue", op: "lt", value: 1 }]);
    expect(out).toEqual([]);
  });

  it("ANDs multiple filters together", () => {
    const out = applyFilters(rows, [
      { field: "product", op: "eq", value: "Drift" },
      { field: "region", op: "eq", value: "APAC" },
    ]);
    expect(out).toHaveLength(1);
  });

  it("does substring matching on contains", () => {
    expect(applyFilters(rows, [{ field: "product", op: "contains", value: "bal" }])).toHaveLength(1);
  });

  it("returns everything when there is nothing to filter by", () => {
    expect(applyFilters(rows, [])).toHaveLength(5);
  });
});

describe("formatValue", () => {
  it("renders currency with its unit and no decimals", () => {
    expect(formatValue(1234567, "currency", "AED")).toBe("AED 1,234,567");
  });

  it("shows an em dash for a missing value rather than 0 or null", () => {
    expect(formatValue(null, "number")).toBe("—");
  });
});
