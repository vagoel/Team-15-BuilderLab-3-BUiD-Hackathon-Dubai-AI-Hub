import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLS } from "../contract/tools.js";
import { useLoom } from "../store.js";
import type { Dataset } from "../contract/dataset.js";

// The research engine is owned by another agent and built in parallel. We only ever
// code against its documented signature (runResearch/deepenResearch/readSource/
// getDataset), so it is mocked here — the point of these tests is the tool-handler
// layer (validation, coercion, store wiring), not the research pipeline itself.
vi.mock("../research/index.js", () => ({
  runResearch: vi.fn(),
  deepenResearch: vi.fn(),
  readSource: vi.fn(),
  getDataset: vi.fn(),
}));

const { createToolHandlers } = await import("./toolHandlers.js");

function makeDataset(id: string): Dataset {
  return {
    id,
    question: "How much is a 2br in Marina vs JVC?",
    headline: "Marina runs about 20% higher",
    createdAt: new Date().toISOString(),
    sources: [],
    fields: [{ key: "price", label: "Price", type: "number" }],
    records: [{ price: 100 }, { price: 200 }, { price: 300 }],
    findings: [],
  };
}

beforeEach(() => {
  useLoom.getState().reset();
  vi.clearAllMocks();
});

describe("createToolHandlers", () => {
  it("registers a handler for every tool in the contract", () => {
    const handlers = createToolHandlers();
    for (const name of Object.keys(TOOLS)) {
      expect(typeof handlers[name]).toBe("function");
    }
  });

  it("render_ui rejects an unknown datasetId and names the ones that exist", async () => {
    useLoom.getState().addDataset(makeDataset("ds1"));
    const handlers = createToolHandlers();
    const result = await handlers.render_ui!({
      datasetId: "does-not-exist",
      components: ["comparison_table"],
    });

    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/does-not-exist/);
    // The model can only recover if it is told what a valid id looks like.
    expect(result as string).toMatch(/ds1/);
    expect(useLoom.getState().spec).toBeNull();
  });

  it("accepts a JSON-string components array where an array was expected", async () => {
    useLoom.getState().addDataset(makeDataset("ds1"));
    const handlers = createToolHandlers();

    const result = await handlers.render_ui!({
      datasetId: "ds1",
      components: JSON.stringify(["comparison_table"]),
      title: "Rents",
    });

    expect(result).toBe("Showing comparison_table.");
    expect(useLoom.getState().spec?.title).toBe("Rents");
  });

  it("reports back any component it could not build from the data", async () => {
    // A chart needs a numeric column and something to group by. Silently dropping it
    // would leave the agent describing a chart that is not on screen.
    useLoom.getState().addDataset(makeDataset("ds1"));
    const handlers = createToolHandlers();

    const result = await handlers.render_ui!({
      datasetId: "ds1",
      components: ["source_list", "findings"],
    });

    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/^Showing /);
  });

  it("accepts a fully-stringified top-level params object", async () => {
    useLoom.getState().setSpec({
      layout: "grid",
      components: [{ id: "stats", type: "stat_cards", items: [{ label: "Median", value: "AED 1.8M" }] }],
    });
    const handlers = createToolHandlers();

    const result = await handlers.focus_component!(JSON.stringify({ id: "stats" }));

    expect(result).toBe("Focused stats");
  });

  it("returns a plain string instead of throwing on a validation failure", async () => {
    const handlers = createToolHandlers();

    const result = await handlers.update_component!({ id: 42, patch: {} });

    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/^update_component failed:/);
  });

  it("render_ui failure never throws even on completely malformed input", async () => {
    const handlers = createToolHandlers();
    await expect(handlers.render_ui!({ components: "not json at all {{{" })).resolves.toEqual(
      expect.any(String),
    );
    await expect(handlers.research!(null)).resolves.toEqual(expect.any(String));
    await expect(handlers.get_ui_state!(undefined)).resolves.not.toBeUndefined();
  });

  it("research with mode add joins the existing report instead of replacing it", async () => {
    const research = await import("../research/index.js");
    const first = makeDataset("ds_first");
    useLoom.getState().addDataset(first);
    useLoom.getState().setSpec({
      title: first.question,
      layout: "grid",
      components: [
        { id: "auto_table", type: "comparison_table", datasetId: "ds_first", columns: ["price"], filters: [], highlights: [] },
      ],
    });

    const second = makeDataset("ds_second");
    vi.mocked(research.runResearch).mockResolvedValue({
      datasetId: "ds_second",
      headline: "h",
      keyFindings: [],
      sourceCount: 0,
      recordCount: 3,
      availableFields: [],
    });
    vi.mocked(research.getDataset).mockReturnValue(second);

    const handlers = createToolHandlers();
    const result = await handlers.research!({
      question: "q2",
      seedUrls: ["https://x.test"],
      fields: [
        { key: "price", label: "Price", type: "number" },
        { key: "name", label: "Name", type: "string" },
      ],
      mode: "add",
    });

    const spec = useLoom.getState().spec!;
    // The original table survives, and the new dataset's components arrive suffixed
    // so the two can be addressed separately.
    expect(spec.components.some((c) => c.id === "auto_table")).toBe(true);
    expect(spec.components.some((c) => c.id.endsWith("__second"))).toBe(true);
    expect(result).toMatchObject({ mode: "add" });
    expect((result as { note: string }).note).toMatch(/ADDED/);
  });

  it("research without mode still replaces the canvas", async () => {
    const research = await import("../research/index.js");
    useLoom.getState().addDataset(makeDataset("ds_first"));
    useLoom.getState().setSpec({
      layout: "grid",
      components: [
        { id: "auto_table", type: "comparison_table", datasetId: "ds_first", columns: ["price"], filters: [], highlights: [] },
      ],
    });

    const second = makeDataset("ds_second");
    vi.mocked(research.runResearch).mockResolvedValue({
      datasetId: "ds_second",
      headline: "h",
      keyFindings: [],
      sourceCount: 0,
      recordCount: 3,
      availableFields: [],
    });
    vi.mocked(research.getDataset).mockReturnValue(second);

    const handlers = createToolHandlers();
    await handlers.research!({
      question: "q2",
      seedUrls: ["https://x.test"],
      fields: [
        { key: "price", label: "Price", type: "number" },
        { key: "name", label: "Name", type: "string" },
      ],
    });

    const spec = useLoom.getState().spec!;
    const datasetIds = spec.components.map((c) => ("datasetId" in c ? c.datasetId : undefined)).filter(Boolean);
    expect(datasetIds.every((id) => id === "ds_second")).toBe(true);
  });

  it("set_filter reports the new visible row count", async () => {
    useLoom.getState().addDataset(makeDataset("ds1"));
    useLoom.getState().setSpec({
      layout: "grid",
      components: [
        { id: "table", type: "comparison_table", datasetId: "ds1", columns: ["price"], filters: [], highlights: [] },
      ],
    });
    const handlers = createToolHandlers();

    const result = await handlers.set_filter!({
      componentId: "table",
      filters: [{ field: "price", op: "lt", value: 250 }],
    });

    expect(result).toBe("Filter applied — 2 rows visible");
  });

  it("set_filter reports an error for an unknown component id", async () => {
    const handlers = createToolHandlers();
    const result = await handlers.set_filter!({ componentId: "nope", filters: [] });
    expect(result).toMatch(/set_filter failed/);
  });

  it("update_component patches a mounted component", async () => {
    useLoom.getState().setSpec({
      layout: "grid",
      components: [
        { id: "chart1", type: "chart", datasetId: "ds1", kind: "bar", x: "price", y: ["price"], filters: [] },
      ],
    });
    const handlers = createToolHandlers();

    const result = await handlers.update_component!({ id: "chart1", patch: { kind: "line" } });

    expect(result).toBe("Updated chart1");
    const spec = useLoom.getState().spec;
    const comp = spec?.components.find((c) => c.id === "chart1");
    expect(comp && "kind" in comp ? comp.kind : undefined).toBe("line");
  });

  it("get_ui_state reflects what render_ui just mounted", async () => {
    useLoom.getState().addDataset(makeDataset("ds1"));
    const handlers = createToolHandlers();
    await handlers.render_ui!({ datasetId: "ds1", components: ["comparison_table"] });

    const state = await handlers.get_ui_state!({});
    // Auto-built components get predictable ids the agent can target directly.
    expect(state).toMatchObject({
      components: [{ id: "auto_table", type: "comparison_table", datasetId: "ds1" }],
    });
  });

  it("update_component rejects a patch that would corrupt the component instead of applying it", async () => {
    // patchComponent (store.ts) merges the patch into the live spec unconditionally
    // and reports success regardless of the result — there is no validation below
    // this handler. A `filters` string instead of an array would pass straight
    // through to `applyFilters`/Chart, which call `.every`/`.map` on it and throw —
    // with no error boundary above the canvas, that is a blank screen mid-demo. The
    // handler itself must catch this before it ever reaches the store.
    useLoom.getState().setSpec({
      layout: "grid",
      components: [
        { id: "chart1", type: "chart", datasetId: "ds1", kind: "bar", x: "price", y: ["price"], filters: [] },
      ],
    });
    const handlers = createToolHandlers();

    const result = await handlers.update_component!({ id: "chart1", patch: { filters: "not-an-array" } });

    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/^update_component failed:/);
    const comp = useLoom.getState().spec?.components.find((c) => c.id === "chart1");
    expect(comp && "filters" in comp ? comp.filters : undefined).toEqual([]);
  });

  it("update_component refuses to change a component's type", async () => {
    useLoom.getState().setSpec({
      layout: "grid",
      components: [
        { id: "chart1", type: "chart", datasetId: "ds1", kind: "bar", x: "price", y: ["price"], filters: [] },
      ],
    });
    const handlers = createToolHandlers();

    const result = await handlers.update_component!({ id: "chart1", patch: { type: "stat_cards" } });

    expect(result as string).toMatch(/^update_component failed:/);
    expect(useLoom.getState().spec?.components.find((c) => c.id === "chart1")?.type).toBe("chart");
  });

  it("scroll_component never throws, even when the DOM it reaches into is unavailable", async () => {
    // This test environment has no document/CSS globals (no jsdom is installed),
    // which stands in for the DOM disappearing out from under the handler — a
    // re-render that swapped the node, or a browser missing CSS.escape. Either way
    // the handler must resolve with a string, never reject.
    useLoom.getState().setSpec({
      layout: "grid",
      components: [
        { id: "table", type: "comparison_table", datasetId: "ds1", columns: ["price"], filters: [], highlights: [] },
      ],
    });
    const handlers = createToolHandlers();

    const result = await handlers.scroll_component!({ id: "table", to: "down" });

    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/^scroll_component failed:/);
  });

  it("export_report handles missing and in-progress reports without opening the preview", async () => {
    const handlers = createToolHandlers();
    expect(await handlers.export_report!({ action: "preview" })).toMatch(/no report/i);
    useLoom.getState().setSpec({
      layout: "grid",
      components: [{ id: "stats", type: "stat_cards", items: [{ label: "Rows", value: "3" }] }],
    });
    useLoom.getState().setStatus("researching");
    expect(await handlers.export_report!({ action: "preview" })).toMatch(/still being researched/i);
    expect(useLoom.getState().reportPreview.open).toBe(false);
  });

  it("export_report previews first and prints only from an open preview", async () => {
    useLoom.getState().addDataset(makeDataset("ds1"));
    useLoom.getState().setSpec({
      title: "Report",
      layout: "grid",
      components: [{ id: "table", type: "comparison_table", datasetId: "ds1", columns: ["price"], filters: [], highlights: [] }],
    });
    const handlers = createToolHandlers();
    const firstPrint = await handlers.export_report!({ action: "print" });
    expect(firstPrint).toMatch(/preview first/i);
    expect(useLoom.getState().reportPreview.open).toBe(true);
    expect(useLoom.getState().reportPreview.printRequestId).toBe(0);
    const print = await handlers.export_report!({ action: "print" });
    expect(print).toMatch(/print dialog/i);
    expect(useLoom.getState().reportPreview.printRequestId).toBe(1);
  });

  it("export_report defaults to preview and reports its contents", async () => {
    useLoom.getState().addDataset(makeDataset("ds1"));
    useLoom.getState().setSpec({
      layout: "grid",
      components: [{ id: "table", type: "comparison_table", datasetId: "ds1", columns: ["price"], filters: [], highlights: [] }],
    });
    const result = await createToolHandlers().export_report!({});
    expect(result).toMatch(/3 table rows/i);
    expect(useLoom.getState().reportPreview.open).toBe(true);
  });

  it("mock_data times out instead of hanging the voice turn forever on a stalled dev server", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    // Simulates a dev server that accepted the connection but never responds:
    // `fetch` never settles on its own, only when its AbortSignal fires.
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    try {
      const handlers = createToolHandlers();
      const pending = handlers.mock_data!({ table: "sales" });
      await vi.advanceTimersByTimeAsync(8000);
      const result = await pending;

      expect(typeof result).toBe("string");
      expect(result as string).toMatch(/^mock_data failed:/);
      expect(result as string).toMatch(/timed out/i);
    } finally {
      globalThis.fetch = originalFetch;
      vi.useRealTimers();
    }
  });
});
