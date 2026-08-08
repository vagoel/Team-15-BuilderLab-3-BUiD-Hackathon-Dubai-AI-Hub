import { describe, expect, it } from "vitest";
import type { UiSpec } from "../contract/index.js";
import { assertNoDataBindings, serializeTemplateContext, NO_TEMPLATE_CONTEXT } from "../contract/template.js";
import { captureTemplate, TemplateCaptureError } from "./capture.js";

/** A finished pricing report — the thing a user would actually press save on. */
const PRICING_REPORT: UiSpec = {
  title: "Vendor pricing",
  layout: "grid",
  components: [
    { id: "auto_stats", type: "stat_cards", items: [{ label: "Records", value: "108" }] },
    {
      id: "auto_chart",
      type: "chart",
      title: "Price by vendor",
      datasetId: "ds_pricing",
      kind: "pie",
      x: "vendor",
      y: ["price_usd"],
      filters: [],
    },
    {
      id: "auto_table",
      type: "comparison_table",
      title: "All rows",
      datasetId: "ds_pricing",
      columns: ["vendor", "price_usd", "region"],
      filters: [{ field: "price_usd", op: "lt", value: 50 }],
      highlights: [],
    },
    { id: "auto_sources", type: "source_list", title: "Sources", datasetId: "ds_pricing" },
  ],
};

describe("captureTemplate", () => {
  it("keeps the shape of the report and nothing about its subject", () => {
    const template = captureTemplate(PRICING_REPORT, "Comparison layout");

    expect(template.slots.map((s) => s.kind)).toEqual([
      "stat_cards",
      "chart",
      "comparison_table",
      "source_list",
    ]);
    expect(template.slots.map((s) => s.order)).toEqual([0, 1, 2, 3]);

    // This is the whole promise of templates: a layout saved from a pricing report
    // must be usable on restaurants, which it cannot be if it remembers "price_usd".
    const json = JSON.stringify(template);
    expect(json).not.toContain("ds_pricing");
    expect(json).not.toContain("price_usd");
    expect(json).not.toContain("vendor");
    expect(json).not.toContain("region");
  });

  it("keeps chart kind, which is presentation, and drops the axes, which are data", () => {
    const template = captureTemplate(PRICING_REPORT, "L");
    const chart = template.slots.find((s) => s.kind === "chart")!;

    expect(chart.options?.chartKind).toBe("pie");
    // The axes are field keys, so they must not survive capture.
    expect(JSON.stringify(chart)).not.toContain("price_usd");
    expect(JSON.stringify(chart)).not.toContain("vendor");
  });

  it("keeps how many table columns there were, never which ones", () => {
    const template = captureTemplate(PRICING_REPORT, "L");
    const table = template.slots.find((s) => s.kind === "comparison_table")!;

    expect(table.options?.maxColumns).toBe(3);
    expect(JSON.stringify(table)).not.toContain("region");
  });

  it("passes its own no-data-bindings audit", () => {
    expect(() => assertNoDataBindings(captureTemplate(PRICING_REPORT, "L"))).not.toThrow();
  });

  it("refuses to save nothing, or to save without a name", () => {
    expect(() => captureTemplate(null, "L")).toThrow(TemplateCaptureError);
    expect(() => captureTemplate({ ...PRICING_REPORT, components: [] }, "L")).toThrow(/no report/i);
    expect(() => captureTemplate(PRICING_REPORT, "   ")).toThrow(/name/i);
  });

  it("does not carry a generated title, which names the old subject's fields", () => {
    const template = captureTemplate(PRICING_REPORT, "L");
    expect(template.slots.every((s) => s.title === undefined)).toBe(true);
  });

  it("preserves an explicit column span so a pinned width survives a round trip", () => {
    const withSpan: UiSpec = {
      ...PRICING_REPORT,
      components: [{ ...PRICING_REPORT.components[0]!, columnSpan: 6 }],
    };
    expect(captureTemplate(withSpan, "L").slots[0]?.columnSpan).toBe(6);
  });
});

describe("serializeTemplateContext", () => {
  it("sends NONE when nothing is selected", () => {
    expect(serializeTemplateContext(null)).toBe(NO_TEMPLATE_CONTEXT);
  });

  it("sends a compact recipe the agent can read", () => {
    const template = captureTemplate(PRICING_REPORT, "Comparison layout");
    const context = JSON.parse(serializeTemplateContext(template)) as {
      name: string;
      slots: Array<{ kind: string; chartKind?: string }>;
    };

    expect(context.name).toBe("Comparison layout");
    expect(context.slots.map((s) => s.kind)).toEqual([
      "stat_cards",
      "chart",
      "comparison_table",
      "source_list",
    ]);
    expect(context.slots.find((s) => s.kind === "chart")?.chartKind).toBe("pie");
    // It rides along with every session start, so it has to stay small.
    expect(serializeTemplateContext(template).length).toBeLessThan(2000);
  });
});
