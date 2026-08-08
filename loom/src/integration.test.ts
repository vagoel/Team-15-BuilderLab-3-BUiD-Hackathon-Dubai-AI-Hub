import { beforeEach, describe, expect, it, vi } from "vitest";
import { createToolHandlers } from "./voice/toolHandlers.js";
import { useLoom } from "./store.js";
import { resetSourceSets } from "./research/index.js";

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

/**
 * Real markdown tables, because that is now the only thing that produces rows.
 * The column headers become the schema — nobody hands the pipeline a field list.
 */
const TABLE_A = [
  "# Pricing",
  "",
  "| Plan | Price | Seats |",
  "| --- | --- | --- |",
  "| Starter | $29 | 3 |",
  "| Team | $99 | 10 |",
  "| Business | $249 | 50 |",
].join("\n");
const TABLE_B = [
  "# Pricing",
  "",
  "| Plan | Price | Seats |",
  "| --- | --- | --- |",
  "| Basic | $19 | 2 |",
  "| Pro | $79 | 8 |",
].join("\n");

const PROSE_PAGE =
  "# Market notes\n\nVendors in this space rarely publish comparable figures, and the " +
  "spread is wide enough that analysts disagree. This page is entirely prose: there is no " +
  "table anywhere on it, only paragraphs discussing the subject.";

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
  /** URLs whose markdown scrape should fail, and how. */
  fail?: Record<string, { status: number; body: string }>;
  /** Resolve every scrape only after this many ms, to observe concurrency. */
  delayMs?: number;
  /** Serve prose instead of a table, to exercise the zero-rows path. */
  prose?: boolean;
  /** What web search should return as candidates. */
  searchUrls?: string[];
}

function stubContextDev(options: StubOptions = {}) {
  const started: string[] = [];
  const settled: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/brand/retrieve")) {
      return jsonResponse({ status: "ok", brand: { title: "Example", colors: [{ hex: "#5b8cff" }] } });
    }

    if (url.includes("/web/search")) {
      return jsonResponse({
        query: "q",
        results: (options.searchUrls ?? []).map((u, i) => ({
          url: u,
          title: `Result ${i}`,
          description: "a candidate",
          relevance: "high",
        })),
      });
    }

    if (url.includes("/web/scrape/markdown")) {
      const target = decodeURIComponent(url.split("url=")[1] ?? "");
      started.push(target);

      const failure = options.fail?.[target];
      if (failure) {
        settled.push(target);
        return new Response(failure.body, { status: failure.status });
      }

      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      settled.push(target);
      const markdown = options.prose ? PROSE_PAGE : target.includes("//a") ? TABLE_A : TABLE_B;
      return jsonResponse({ success: true, markdown });
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

/**
 * Discover then collect, the way the agent must.
 *
 * Written as a helper because the two-step protocol is the point of this file: every
 * scenario below goes through a real source set, so none of them could smuggle in a
 * URL that discovery never produced.
 */
async function research(
  h: Record<string, (p: unknown) => Promise<unknown>>,
  question: string,
  targets: string[],
  extra: Record<string, unknown> = {},
) {
  const found = (await h.search_web!({ query: question })) as { sourceSetId: string; candidates: unknown[] };
  return (await h.collect_sources!({
    question,
    sourceSetId: found.sourceSetId,
    indexes: targets.map((_, i) => i),
    mode: "markdown",
    ...extra,
  })) as Record<string, unknown>;
}

beforeEach(() => {
  useLoom.getState().reset();
  resetSourceSets();
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
    stubContextDev({ searchUrls: [...BOTH] });
    const h = createToolHandlers();

    const summary = await research(h, "Compare pricing across A and B", [...BOTH]);

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
    stubContextDev({ searchUrls: [...BOTH] });
    const h = createToolHandlers();
    await research(h, "q", [...BOTH]);

    const chart = useLoom.getState().spec!.components.find((c) => c.type === "chart");
    expect(chart).toBeDefined();
    if (chart?.type === "chart") expect(chart.y).toEqual(["price"]);
  });

  it("reads every source in parallel, not one after another", async () => {
    // Serialising two sources at ~22s each is the difference between a demo and a
    // silence. Every request must be in flight before any of them comes back.
    const BOTH = urls();
    const { started, settled } = stubContextDev({ delayMs: 60, searchUrls: [...BOTH] });
    const h = createToolHandlers();

    const run = research(h, "q", [...BOTH]);
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toHaveLength(2);
    expect(settled).toHaveLength(0);
    await run;
  });

  it("degrades to the sources it could read when one page 404s", async () => {
    const BOTH = urls();
    stubContextDev({
      searchUrls: [...BOTH],
      fail: {
        [BOTH[1]]: {
          status: 404,
          body: JSON.stringify({ message: "Target page returned a 404", error_code: "NOT_FOUND" }),
        },
      },
    });
    const h = createToolHandlers();

    const summary = await research(h, "q", [...BOTH]);

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
    stubContextDev({ searchUrls: [...BOTH], fail: { [BOTH[0]]: depleted, [BOTH[1]]: depleted } });
    const h = createToolHandlers();

    const result = await research(h, "q", [...BOTH]);

    // Never a rejected promise: that would cut the agent off mid-sentence.
    expect(result).toBeDefined();
    expect(useLoom.getState().status).not.toBe("researching");
  });

  it("filters by voice and reports a row count the agent can quote", async () => {
    const BOTH = urls();
    stubContextDev({ searchUrls: [...BOTH] });
    const h = createToolHandlers();
    await research(h, "q", [...BOTH]);

    const reply = String(await h.set_filter!({
      componentId: "auto_table",
      filters: [{ field: "price", op: "lt", value: 80 }],
    }));
    expect(reply).toMatch(/3/);

    const state = (await h.get_ui_state!({})) as { components: Array<{ id: string; visibleRows?: number }> };
    expect(state.components.find((c) => c.id === "auto_table")?.visibleRows).toBe(3);
  });

  it("survives a text filter, which used to match every row", async () => {
    const BOTH = urls();
    stubContextDev({ searchUrls: [...BOTH] });
    const h = createToolHandlers();
    await research(h, "q", [...BOTH]);

    await h.set_filter!({ componentId: "auto_table", filters: [{ field: "plan", op: "eq", value: "Team" }] });
    const state = (await h.get_ui_state!({})) as { components: Array<{ id: string; visibleRows?: number }> };
    expect(state.components.find((c) => c.id === "auto_table")?.visibleRows).toBe(1);
  });

  it("adds, moves and removes components without rebuilding the dashboard", async () => {
    const BOTH = urls();
    stubContextDev({ searchUrls: [...BOTH] });
    const h = createToolHandlers();
    const summary = (await research(h, "q", [...BOTH])) as unknown as { datasetId: string };

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

  it("a prose-only topic produces sources and findings, never a fabricated table", async () => {
    const BOTH = urls();
    stubContextDev({ searchUrls: [...BOTH], prose: true });
    const h = createToolHandlers();

    const summary = await research(h, "q", [...BOTH]);
    expect(summary.recordCount).toBe(0);
    // The agent is told in the tool result, not left to infer it from a zero.
    expect(String(summary.note)).toMatch(/NO table rows/);

    const datasetId = String(summary.datasetId);
    const dataset = useLoom.getState().datasets[datasetId]!;
    expect(dataset.records).toEqual([]);
    // The sources were read successfully — prose is material, not failure.
    expect(dataset.sources.every((src) => src.fetchedAt && !src.error)).toBe(true);

    // And the agent can turn them into a report by citing what it read.
    const sourceId = dataset.sources[0]!.id;
    const ok = await h.set_research_findings!({
      datasetId,
      findings: [{ text: "Vendors rarely publish comparable figures.", sourceId }],
    });
    expect(String(ok)).toMatch(/Added 1 finding/);
    expect(useLoom.getState().datasets[datasetId]!.findings[0]?.sourceIds).toEqual([sourceId]);
  });

  it("refuses a finding whose source is not in the dataset", async () => {
    const BOTH = urls();
    stubContextDev({ searchUrls: [...BOTH], prose: true });
    const h = createToolHandlers();
    const summary = await research(h, "q", [...BOTH]);

    // Without this check, this tool is a licence to write anything into a report
    // and have it look researched.
    const result = await h.set_research_findings!({
      datasetId: String(summary.datasetId),
      findings: [{ text: "Something I remembered", sourceId: "src_invented" }],
    });
    expect(String(result)).toMatch(/not in this dataset/);
  });

  it("registers user-supplied URLs without searching, and reads them", async () => {
    const BOTH = urls();
    const { fetchMock } = stubContextDev({ searchUrls: [] });
    const h = createToolHandlers();

    const registered = (await h.use_direct_urls!({ topic: "those pages", urls: [BOTH[0]] })) as {
      sourceSetId: string;
    };
    const summary = (await h.collect_sources!({
      question: "q",
      sourceSetId: registered.sourceSetId,
      indexes: [0],
      mode: "markdown",
    })) as Record<string, unknown>;

    expect(summary.recordCount).toBe(3);
    const requested = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(requested.some((u) => u.includes("/web/search"))).toBe(false);
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
