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
  searchForSources: vi.fn(),
  registerDirectUrls: vi.fn(),
  datasetHasSource: vi.fn(() => true),
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
    await expect(handlers.collect_sources!(null)).resolves.toEqual(expect.any(String));
    await expect(handlers.search_web!(null)).resolves.toEqual(expect.any(String));
    await expect(handlers.get_ui_state!(undefined)).resolves.not.toBeUndefined();
  });

  it("collect_sources with report_mode add joins the existing report", async () => {
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
      sourceCount: 1,
      recordCount: 3,
      availableFields: [],
    });
    vi.mocked(research.getDataset).mockReturnValue(second);

    const handlers = createToolHandlers();
    const result = await handlers.collect_sources!({
      question: "q2",
      sourceSetId: "ss_x",
      indexes: [0],
      mode: "markdown",
      report_mode: "add",
    });

    const spec = useLoom.getState().spec!;
    expect(spec.components.some((c) => c.id === "auto_table")).toBe(true);
    expect(spec.components.some((c) => c.id.endsWith("__second"))).toBe(true);
    expect(result).toMatchObject({ reportMode: "add" });
  });

  it("collect_sources tells the agent outright when no rows were produced", async () => {
    const research = await import("../research/index.js");
    const empty = { ...makeDataset("ds_prose"), records: [], fields: [] };
    vi.mocked(research.runResearch).mockResolvedValue({
      datasetId: "ds_prose",
      headline: "no tables",
      keyFindings: [],
      sourceCount: 1,
      recordCount: 0,
      availableFields: [],
    });
    vi.mocked(research.getDataset).mockReturnValue(empty);

    const handlers = createToolHandlers();
    const result = (await handlers.collect_sources!({
      question: "q",
      sourceSetId: "ss_x",
      indexes: [0],
      mode: "markdown",
    })) as { note: string };

    // Left to infer it from recordCount: 0, the agent narrated a full table over an
    // empty dataset. So the tool result says it in words.
    expect(result.note).toMatch(/NO table rows/);
    expect(result.note).toMatch(/read a source/i);
  });

  it("search_web hands back indexed candidates and tells the agent not to send URLs", async () => {
    const research = await import("../research/index.js");
    vi.mocked(research.searchForSources).mockResolvedValue({
      id: "ss_1",
      origin: "search",
      query: "q",
      createdAt: new Date().toISOString(),
      candidates: [
        { index: 0, url: "https://a.test", title: "A", description: "d" },
        { index: 1, url: "https://b.test", title: "B" },
      ],
    });

    const handlers = createToolHandlers();
    const result = (await handlers.search_web!({ query: "q" })) as {
      sourceSetId: string;
      candidates: Array<{ index: number }>;
      note: string;
    };

    expect(result.sourceSetId).toBe("ss_1");
    expect(result.candidates.map((c) => c.index)).toEqual([0, 1]);
    expect(result.note).toMatch(/only indexes/i);
  });

  it("set_research_findings rejects a sourceId that is not in the dataset", async () => {
    const research = await import("../research/index.js");
    useLoom.getState().addDataset(makeDataset("ds1"));
    vi.mocked(research.datasetHasSource).mockReturnValue(false);

    const handlers = createToolHandlers();
    const result = await handlers.set_research_findings!({
      datasetId: "ds1",
      findings: [{ text: "something", sourceId: "src_made_up" }],
    });

    expect(String(result)).toMatch(/not in this dataset/);
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
