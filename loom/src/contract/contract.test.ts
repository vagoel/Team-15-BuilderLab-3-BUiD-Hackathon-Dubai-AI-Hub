import { describe, expect, it } from "vitest";
import { ExportReportParams, RenderUiParams, TOOLS, toElevenLabsTool } from "./tools.js";
import { Filter, UiSpec } from "./ui.js";

describe("tool contract", () => {
  it("keys the tool map by the tool's own name", () => {
    // If these drift, the dashboard config and the runtime handlers stop agreeing.
    for (const [key, tool] of Object.entries(TOOLS)) {
      expect(tool.name).toBe(key);
    }
  });

  it("renders every tool into a declaration ElevenLabs can consume", () => {
    for (const tool of Object.values(TOOLS)) {
      const declared = toElevenLabsTool(tool);
      expect(declared.name).toBe(tool.name);
      expect(declared.description.length).toBeGreaterThan(20);

      const schema =
        "parameters" in declared ? declared.parameters : declared.api_schema.request_body_schema;
      expect(schema).toMatchObject({ type: "object" });
    }
  });

  it("marks the tools the agent must block on", () => {
    // These are the ones whose return value changes what the agent says next.
    expect(TOOLS.get_ui_state.waitForResponse).toBe(true);
    expect(TOOLS.set_filter.waitForResponse).toBe(true);
    expect(TOOLS.render_ui.waitForResponse).toBe(true);
    expect(TOOLS.export_report.waitForResponse).toBe(true);
  });

  it("blocks on every step of the discovery-then-retrieval protocol", () => {
    // Non-blocking discovery would be worse than useless: the agent would pick
    // candidate indexes without ever seeing the candidates.
    expect(TOOLS.search_web.waitForResponse).toBe(true);
    expect(TOOLS.use_direct_urls.waitForResponse).toBe(true);
    expect(TOOLS.collect_sources.waitForResponse).toBe(true);
    expect(TOOLS.set_research_findings.waitForResponse).toBe(true);
  });

  it("gives the slow tools something to say while they run", () => {
    expect(TOOLS.search_web.preToolSpeech).toBeTruthy();
    expect(TOOLS.collect_sources.preToolSpeech).toBeTruthy();
  });

  it("offers no way to hand a retrieval tool a raw URL", () => {
    // Provenance is a protocol, not prompt advice: collect_sources takes indexes
    // into a registered source set, so an invented URL has nowhere to enter.
    const declared = toElevenLabsTool(TOOLS.collect_sources);
    const props = Object.keys(("parameters" in declared ? declared.parameters.properties : {}) ?? {});
    expect(props).toContain("sourceSetId");
    expect(props).toContain("indexes");
    expect(props).not.toContain("urls");
    expect(props).not.toContain("seedUrls");
  });

  it("declares no structured-extraction tool", () => {
    expect(Object.keys(TOOLS)).not.toContain("research");
    expect(JSON.stringify(TOOLS)).not.toContain("web/extract");
  });
});

describe("export_report parameters", () => {
  it("keeps a flat string action and defaults to preview", () => {
    expect(ExportReportParams.parse({})).toEqual({ action: "preview" });
    const schema = (toElevenLabsTool(TOOLS.export_report) as { parameters: any }).parameters;
    expect(schema.properties.action.type).toBe("string");
    expect(schema.properties.action.enum).toEqual(["preview", "print"]);
  });
});

describe("UiSpec", () => {
  const validSpec = {
    title: "Marina vs JVC",
    layout: "grid" as const,
    components: [
      {
        id: "stats",
        type: "stat_cards" as const,
        items: [{ label: "Median", value: "AED 1.8M" }],
      },
      {
        id: "table",
        type: "comparison_table" as const,
        datasetId: "ds_1",
        columns: ["area", "price_aed"],
      },
    ],
  };

  it("accepts a realistic dashboard and defaults the filters", () => {
    const parsed = UiSpec.parse(validSpec);
    expect(parsed.components).toHaveLength(2);
    const table = parsed.components[1];
    expect(table?.type).toBe("comparison_table");
    if (table?.type === "comparison_table") expect(table.filters).toEqual([]);
  });

  it("rejects a component type the renderer does not implement", () => {
    const bad = {
      ...validSpec,
      components: [{ id: "x", type: "pie_chart", datasetId: "ds_1" }],
    };
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });

  it("rejects a table with no dataset to read from", () => {
    const bad = {
      ...validSpec,
      components: [{ id: "t", type: "comparison_table", columns: ["a"] }],
    };
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });

  it("caps a dashboard so the canvas stays legible, with room for a combined report", () => {
    // Ten, not six: a combined report holds components from more than one dataset.
    const many = {
      ...validSpec,
      components: Array.from({ length: 11 }, (_, i) => ({
        id: `s${i}`,
        type: "stat_cards" as const,
        items: [{ label: "x", value: "1" }],
      })),
    };
    expect(UiSpec.safeParse(many).success).toBe(false);
  });
});

describe("layout and sizing", () => {
  const table = {
    id: "t",
    type: "comparison_table" as const,
    datasetId: "ds_1",
    columns: ["a"],
  };

  it("defaults a spec with no layout to the structured grid", () => {
    expect(UiSpec.parse({ components: [table] }).layout).toBe("grid");
  });

  it("accepts every switchable preset and rejects an invented one", () => {
    for (const layout of ["stack", "grid", "masonry", "focus"]) {
      expect(UiSpec.safeParse({ layout, components: [table] }).success).toBe(true);
    }
    expect(UiSpec.safeParse({ layout: "carousel", components: [table] }).success).toBe(false);
  });

  it("carries a per-component size and rejects spans off the 12-column grid", () => {
    const sized = { ...table, size: { span: 7, height: 400 } };
    const parsed = UiSpec.parse({ components: [sized] });
    expect(parsed.components[0]?.size).toEqual({ span: 7, height: 400 });

    expect(UiSpec.safeParse({ components: [{ ...table, size: { span: 13 } }] }).success).toBe(false);
    expect(UiSpec.safeParse({ components: [{ ...table, size: { height: 40 } }] }).success).toBe(false);
  });

  it("still parses a pre-resize spec with no size anywhere", () => {
    // Undo history and any serialized spec from before this feature must keep loading.
    const parsed = UiSpec.parse({ layout: "grid", components: [table] });
    expect(parsed.components[0]?.size).toBeUndefined();
  });
});

describe("render_ui parameters", () => {
  it("stays flat enough that the model cannot get it wrong", () => {
    // It used to take a whole UiSpec. ElevenLabs cannot express the component union,
    // so the model guessed the shape and looped on invalid specs. Intent in, layout
    // derived here. If anyone nests this again, this test should stop them.
    const ok = RenderUiParams.safeParse({
      datasetId: "ds_1",
      components: ["stat_cards", "chart", "comparison_table"],
    });
    expect(ok.success).toBe(true);

    const schema = (toElevenLabsTool(TOOLS.render_ui) as { parameters: any }).parameters;
    expect(schema.properties.components.type).toBe("array");
    expect(schema.properties.components.items.type).toBe("string");
    expect(schema.properties.spec).toBeUndefined();
  });

  it("rejects a component name the renderer does not implement", () => {
    const bad = RenderUiParams.safeParse({ datasetId: "ds_1", components: ["pie_chart"] });
    expect(bad.success).toBe(false);
  });
});

/**
 * ElevenLabs can only be told one JSON type per field. Twice now, a union collapsed to
 * "object", the model believed it, and every call to that tool failed — first on
 * render_ui's component union, then on set_filter's `value`. These pin the collapse
 * rule so it cannot happen a third time.
 */
describe("schema collapse for the model", () => {
  function walk(node: any, path: string, hit: (p: string, n: any) => void) {
    if (!node || typeof node !== "object") return;
    hit(path, node);
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`, hit);
    if (node.items) walk(node.items, `${path}[]`, hit);
  }

  it("never declares a scalar field as an object", () => {
    const offenders: string[] = [];
    for (const tool of Object.values(TOOLS)) {
      const declared = toElevenLabsTool(tool) as { parameters: any };
      walk(declared.parameters, tool.name, (path, node) => {
        // An object with no properties is the tell-tale of a collapsed union.
        if (node.type === "object" && !node.properties && path !== tool.name) offenders.push(path);
      });
    }
    expect(offenders.filter((p) => p.endsWith(".value"))).toEqual([]);
  });

  it("declares set_filter's value as a string, not an object", () => {
    const declared = toElevenLabsTool(TOOLS.set_filter) as { parameters: any };
    expect(declared.parameters.properties.filters.items.properties.value.type).toBe("string");
  });
});

/**
 * A third variant of the same failure class, caught this time before it shipped:
 * `z.toJSONSchema(schema, { io: "input" })` derives `required` from each field's
 * *input* type. `value` is `z.preprocess(fn, z.union([string, number]))`, and a
 * preprocess's input type is `unknown` — it has to accept anything before its
 * function runs — so the deriver read that as "undefined is fine" and silently
 * dropped `value` out of `required`, even though `Filter.parse` rejects a call that
 * omits it. The model would have been told the one field it always needs is
 * optional, and every set_filter call that left it out would have failed validation.
 */
describe("required fields survive io: \"input\" generation", () => {
  it("keeps set_filter's value required, not just typed", () => {
    const declared = toElevenLabsTool(TOOLS.set_filter) as { parameters: any };
    expect(declared.parameters.properties.filters.items.required).toEqual(
      expect.arrayContaining(["field", "op", "value"]),
    );
  });

  it("never drops a field with no zod default or .optional() out of required", () => {
    // Broader guard: for every tool, everything in the top-level params shape that
    // is not actually optional at the zod level must appear in the declared
    // `required` list — catches this class of bug anywhere else it turns up, not
    // just on this one field.
    for (const tool of Object.values(TOOLS)) {
      const declared = toElevenLabsTool(tool) as { parameters: any };
      const shape = (tool.params as unknown as { shape?: Record<string, { isOptional(): boolean }> }).shape;
      if (!shape) continue;
      const trulyRequired = Object.keys(shape).filter((k) => !shape[k]!.isOptional());
      for (const key of trulyRequired) {
        expect(declared.parameters.required, `${tool.name}.${key} should be required`).toContain(key);
      }
    }
  });
});

describe("Filter.value tolerance", () => {
  const base = { field: "product", op: "eq" as const };

  it("accepts the plain scalars", () => {
    expect(Filter.parse({ ...base, value: "Drift" }).value).toBe("Drift");
    expect(Filter.parse({ ...base, value: 42 }).value).toBe(42);
  });

  it("unwraps the shapes a model improvises when told value is an object", () => {
    expect(Filter.parse({ ...base, value: { value: "Drift" } }).value).toBe("Drift");
    expect(Filter.parse({ ...base, value: ["Drift"] }).value).toBe("Drift");
    expect(Filter.parse({ ...base, value: true }).value).toBe("true");
  });

  it("joins a multi-value array rather than dropping the extras", () => {
    expect(Filter.parse({ ...base, value: ["Drift", "Atlas"] }).value).toBe("Drift,Atlas");
  });
});
