import { beforeEach, describe, expect, it, vi } from "vitest";
import { createToolHandlers } from "./voice/toolHandlers.js";
import { useLoom } from "./store.js";

/**
 * The demo path, end to end, against a stubbed context.dev.
 *
 * Everything below the tool boundary is real: the research pipeline, the cache, the
 * auto-layout, the store, `applyFilters`. Only the network is faked, and it is faked
 * in the exact shapes the real API returns — including its failure shapes, which is
 * the point. The live API was out of credits for most of this build, so this is the
 * only thing standing between "the code compiles" and "the demo works".
 *
 * If this file passes and a real key is plugged in, the remaining risk is latency and
 * the model's judgement, not our code.
 */

const ROWS_A = [
  { plan: "Starter", price_usd: 29, seats: 3 },
  { plan: "Team", price_usd: 99, seats: 10 },
  { plan: "Business", price_usd: 249, seats: 50 },
];
const ROWS_B = [
  { plan: "Basic", price_usd: 19, seats: 2 },
  { plan: "Pro", price_usd: 79, seats: 8 },
];

/**
 * Every test gets its own URLs.
 *
 * The cache is a module-level Map that deliberately outlives a single run — that is
 * what turns a 3.4s scrape into 0.9s on stage. It also means a URL cached by an
 * earlier test is served from memory in a later one, which silently masked the
 * failure-path test below until it was caught here. Unique URLs per test, rather than
 * reaching into private state to clear it.
 */
let suite = 0;
function urls(): [string, string] {
  suite += 1;
  return [`https://a${suite}.example/pricing`, `https://b${suite}.example/pricing`];
}

interface StubOptions {
  /** URLs whose extract call should fail, and how. */
  fail?: Record<string, { status: number; body: string }>;
  /** Resolve every extract only after this many ms, to observe concurrency. */
  delayMs?: number;
}

function stubContextDev(options: StubOptions = {}) {
  const started: string[] = [];
  const settled: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/brand/retrieve")) {
      return jsonResponse({ status: "ok", brand: { title: "Example", colors: [{ hex: "#5b8cff" }] } });
    }

    if (url.includes("/web/scrape/markdown")) {
      return jsonResponse({ success: true, markdown: "# Pricing\n\nStarter $29\nTeam $99\n" });
    }

    if (url.includes("/web/extract")) {
      const target = JSON.parse(String(init?.body ?? "{}")).url as string;
      started.push(target);

      const failure = options.fail?.[target];
      if (failure) {
        settled.push(target);
        return new Response(failure.body, { status: failure.status });
      }

      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      settled.push(target);
      return jsonResponse({
        status: "ok",
        url: target,
        data: { records: target.includes("//a") ? ROWS_A : ROWS_B },
      });
    }

    if (url.includes("/api/mock/")) {
      return new Response("plan,price_usd\nStarter,29\nTeam,99\n", {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    }

    throw new Error(`unstubbed fetch: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { started, settled, fetchMock };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const FIELDS = [
  { key: "plan", label: "Plan", type: "string" as const },
  { key: "price_usd", label: "Price", type: "currency" as const, unit: "$" },
  { key: "seats", label: "Seats", type: "number" as const },
];

beforeEach(() => {
  useLoom.getState().reset();
  vi.unstubAllGlobals();
  try {
    sessionStorage.clear();
  } catch {
    /* not available in this environment; the cache degrades to memory */
  }
});

describe("the demo path", () => {
  it("researches, mounts a dashboard, and hands the model only a summary", async () => {
    const BOTH = urls();
    stubContextDev();
    const h = createToolHandlers();

    const summary = (await h.research!({
      question: "Compare pricing across A and B",
      seedUrls: [...BOTH],
      fields: FIELDS,
    })) as Record<string, unknown>;

    // The model must never receive the rows themselves — that is the whole latency plan.
    expect(JSON.stringify(summary).length).toBeLessThan(2000);
    expect(summary.recordCount).toBe(5);
    expect(summary.sourceCount).toBe(2);

    // The dashboard mounts without the model asking for it.
    const spec = useLoom.getState().spec;
    expect(spec).not.toBeNull();
    expect(spec!.components.map((c) => c.type)).toContain("comparison_table");
    expect(summary.note).toMatch(/do not call render_ui/i);

    // Rows are attributed, so the table can say where each came from.
    const dataset = useLoom.getState().datasets[String(summary.datasetId)]!;
    expect(dataset.records.every((r) => typeof r._source === "string")).toBe(true);
  });

  it("charts the money column rather than whichever number came first", async () => {
    const BOTH = urls();
    stubContextDev();
    const h = createToolHandlers();
    await h.research!({ question: "q", seedUrls: [...BOTH], fields: FIELDS });

    const chart = useLoom.getState().spec!.components.find((c) => c.type === "chart");
    expect(chart).toBeDefined();
    if (chart?.type === "chart") expect(chart.y).toEqual(["price_usd"]);
  });

  it("reads every source in parallel, not one after another", async () => {
    // Serialising two sources at ~22s each is the difference between a demo and a
    // silence. Every request must be in flight before any of them comes back.
    const BOTH = urls();
    const { started, settled } = stubContextDev({ delayMs: 60 });
    const h = createToolHandlers();

    const run = h.research!({ question: "q", seedUrls: [...BOTH], fields: FIELDS });
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toHaveLength(2);
    expect(settled).toHaveLength(0);
    await run;
  });

  it("degrades to the sources it could read when one page 404s", async () => {
    const BOTH = urls();
    stubContextDev({
      fail: {
        [BOTH[1]]: {
          status: 404,
          body: JSON.stringify({ message: "Target page returned a 404", error_code: "NOT_FOUND" }),
        },
      },
    });
    const h = createToolHandlers();

    const summary = (await h.research!({
      question: "q",
      seedUrls: [...BOTH],
      fields: FIELDS,
    })) as Record<string, unknown>;

    // The run survives and still renders — one dead URL must never take the demo down.
    expect(useLoom.getState().spec).not.toBeNull();
    expect(Number(summary.recordCount)).toBeGreaterThanOrEqual(3);

    // And the dead source is visibly marked, so the source list can say so rather
    // than quietly presenting two sources as if both had been read.
    const dataset = useLoom.getState().datasets[String(summary.datasetId)]!;
    const dead = dataset.sources.find((src) => src.url === BOTH[1]);
    expect(dead, "the failing source should still appear in the source list").toBeDefined();
    expect(dead?.error ?? dead?.fetchedAt === undefined).toBeTruthy();
  });

  it("still resolves usefully when the credits have run out mid-demo", async () => {
    const BOTH = urls();
    const depleted = {
      status: 401,
      body: JSON.stringify({ message: "credits have been completely depleted", error_code: "USAGE_EXCEEDED" }),
    };
    stubContextDev({ fail: { [BOTH[0]]: depleted, [BOTH[1]]: depleted } });
    const h = createToolHandlers();

    const result = await h.research!({ question: "q", seedUrls: [...BOTH], fields: FIELDS });

    // Never a rejected promise: that would cut the agent off mid-sentence.
    expect(result).toBeDefined();
    expect(useLoom.getState().status).not.toBe("researching");
  });

  it("filters by voice and reports a row count the agent can quote", async () => {
    const BOTH = urls();
    stubContextDev();
    const h = createToolHandlers();
    await h.research!({ question: "q", seedUrls: [...BOTH], fields: FIELDS });

    const reply = String(await h.set_filter!({
      componentId: "auto_table",
      filters: [{ field: "price_usd", op: "lt", value: 80 }],
    }));
    expect(reply).toMatch(/3/);

    const state = (await h.get_ui_state!({})) as { components: Array<{ id: string; visibleRows?: number }> };
    expect(state.components.find((c) => c.id === "auto_table")?.visibleRows).toBe(3);
  });

  it("survives a text filter, which used to match every row", async () => {
    const BOTH = urls();
    stubContextDev();
    const h = createToolHandlers();
    await h.research!({ question: "q", seedUrls: [...BOTH], fields: FIELDS });

    await h.set_filter!({ componentId: "auto_table", filters: [{ field: "plan", op: "eq", value: "Team" }] });
    const state = (await h.get_ui_state!({})) as { components: Array<{ id: string; visibleRows?: number }> };
    expect(state.components.find((c) => c.id === "auto_table")?.visibleRows).toBe(1);
  });

  it("adds, moves and removes components without rebuilding the dashboard", async () => {
    const BOTH = urls();
    stubContextDev();
    const h = createToolHandlers();
    const summary = (await h.research!({ question: "q", seedUrls: [...BOTH], fields: FIELDS })) as {
      datasetId: string;
    };

    await h.remove_component!({ id: "auto_chart" });
    expect(ids()).not.toContain("auto_chart");

    await h.add_component!({ datasetId: summary.datasetId, type: "chart" });
    expect(ids()).toContain("auto_chart");

    // A second table is a fair ask — two views of the same rows, filtered differently.
    await h.add_component!({ datasetId: summary.datasetId, type: "comparison_table" });
    expect(ids()).toContain("auto_table_2");

    await h.move_component!({ id: "auto_table", position: 0 });
    expect(ids()[0]).toBe("auto_table");

    await h.remove_component!({ id: "nope" });
  });

  it("never throws out of a handler, whatever the model sends", async () => {
    stubContextDev();
    const h = createToolHandlers();

    const junk = [undefined, null, "", "not json {{{", 42, [], { spec: "gone" }];
    for (const [name, handler] of Object.entries(h)) {
      for (const input of junk) {
        await expect(handler(input as never), `${name} threw on ${JSON.stringify(input)}`).resolves.toBeDefined();
      }
    }
  });
});

function ids(): string[] {
  return useLoom.getState().spec?.components.map((c) => c.id) ?? [];
}
