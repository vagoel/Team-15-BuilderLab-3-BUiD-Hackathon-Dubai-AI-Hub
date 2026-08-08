import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLoom } from "../store.js";
import {
  deepenResearch,
  getDataset,
  registerDirectUrls,
  resetSourceSets,
  runResearch,
  searchForSources,
  type ResearchHooks,
} from "./index.js";

/**
 * All network access is stubbed — these tests never touch the real context.dev API.
 * See context.ts for the request/response shapes these mocks emulate, confirmed
 * against the live API before this file was written.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/** A page whose data really is in a table — the only thing that yields rows. */
const TABLE_PAGE = [
  "# Vendor pricing",
  "",
  "| Vendor | Price | Region |",
  "| --- | --- | --- |",
  "| Northwind | $12.50 | EU |",
  "| Solstice | $9.00 | US |",
  "| Meridian | $21.25 | APAC |",
].join("\n");

/** A page with plenty of text and no table. Must produce zero rows, ever. */
const PROSE_PAGE =
  "# A considered essay\n\nPricing in this market moves constantly, and vendors rarely publish " +
  "comparable figures. Analysts describe the spread as wide. There is no table on this page at " +
  "all, only several paragraphs of perfectly readable prose about the subject at hand.";

function searchResponse(urls: string[]) {
  return jsonResponse({
    query: "q",
    results: urls.map((url, i) => ({ url, title: `Result ${i}`, description: "…", relevance: "high" })),
  });
}

/** Stub every endpoint; markdown content is chosen per-URL by the caller. */
function stubNetwork(pages: Record<string, string>, opts: { searchUrls?: string[] } = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push(u);

    if (u.includes("/web/search")) return searchResponse(opts.searchUrls ?? Object.keys(pages));
    if (u.includes("/web/scrape/images")) {
      return jsonResponse({
        success: true,
        images: [
          { src: "https://cdn.test/a.png", alt: "A", element: "img" },
          { src: "https://cdn.test/a.png", alt: "duplicate", element: "img" },
          { src: "data:image/gif;base64,R0lGOD", element: "img" },
        ],
      });
    }
    if (u.includes("/web/crawl")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { url: string; limit: number };
      const markdown = pages[body.url] ?? PROSE_PAGE;
      return jsonResponse({
        results: [{ markdown, metadata: { sourceUrl: body.url, finalUrl: body.url, title: "Crawled", crawlDepth: 0 } }],
      });
    }
    if (u.includes("/web/scrape/markdown")) {
      const target = decodeURIComponent(u.split("url=")[1] ?? "");
      const markdown = pages[target];
      if (markdown === undefined) return jsonResponse({ message: "not found" }, 404);
      return jsonResponse({ success: true, markdown });
    }
    return jsonResponse({ message: "no brand" }, 400);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {
  useLoom.getState().reset();
  resetSourceSets();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("search provenance", () => {
  it("cannot retrieve a URL that discovery never returned", async () => {
    stubNetwork({ "https://a.test/pricing": TABLE_PAGE });
    const set = await searchForSources("vendor pricing");

    // Index 99 does not exist. There is no parameter that accepts a raw URL, so
    // this is the closest an agent can get to substituting one — and it fails.
    await expect(
      runResearch({ question: "q", sourceSetId: set.id, indexes: [99], mode: "markdown" }),
    ).rejects.toThrow(/out of range/);
  });

  it("rejects an unknown sourceSetId and names the ones that exist", async () => {
    stubNetwork({ "https://a.test/pricing": TABLE_PAGE });
    const set = await searchForSources("vendor pricing");

    await expect(
      runResearch({ question: "q", sourceSetId: "ss_nope", indexes: [0], mode: "markdown" }),
    ).rejects.toThrow(new RegExp(set.id));
  });

  it("searches before it reads", async () => {
    const { calls } = stubNetwork({ "https://a.test/pricing": TABLE_PAGE });
    const set = await searchForSources("vendor pricing");
    await runResearch({ question: "q", sourceSetId: set.id, indexes: [0], mode: "markdown" });

    const searchAt = calls.findIndex((u) => u.includes("/web/search"));
    const readAt = calls.findIndex((u) => u.includes("/web/scrape/markdown"));
    expect(searchAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(searchAt);
    expect(calls.some((u) => u.includes("/web/extract"))).toBe(false);
  });

  it("direct URLs skip search entirely", async () => {
    const { calls } = stubNetwork({ "https://given.test/a": TABLE_PAGE });
    const set = registerDirectUrls("those pages", ["https://given.test/a"]);
    await runResearch({ question: "q", sourceSetId: set.id, indexes: [0], mode: "markdown" });

    expect(set.origin).toBe("direct");
    expect(calls.some((u) => u.includes("/web/search"))).toBe(false);
    expect(calls.some((u) => u.includes("/web/scrape/markdown"))).toBe(true);
  });

  it("refuses URLs a browser has no business fetching", () => {
    expect(() => registerDirectUrls("t", ["javascript:alert(1)"])).toThrow();
    expect(() => registerDirectUrls("t", ["https://user:pw@host.test/x"])).toThrow(/credentials/);
  });
});

describe("rows come only from real tables", () => {
  it("reads every row of a genuine markdown table and types its columns", async () => {
    stubNetwork({ "https://a.test/pricing": TABLE_PAGE });
    const set = registerDirectUrls("t", ["https://a.test/pricing"]);
    const summary = await runResearch({ question: "q", sourceSetId: set.id, indexes: [0], mode: "markdown" });

    expect(summary.recordCount).toBe(3);
    const dataset = getDataset(summary.datasetId)!;
    // The schema comes from the page's own headers now — nobody supplies fields.
    expect(dataset.fields.map((f) => f.key)).toEqual(["vendor", "price", "region"]);
    expect(dataset.fields.find((f) => f.key === "price")?.type).toBe("currency");
    expect(dataset.records[0]).toMatchObject({ vendor: "Northwind", price: 12.5, region: "EU" });
  });

  it("produces ZERO rows for a prose page, and says so rather than inventing any", async () => {
    stubNetwork({ "https://a.test/essay": PROSE_PAGE });
    const set = registerDirectUrls("t", ["https://a.test/essay"]);
    const summary = await runResearch({ question: "q", sourceSetId: set.id, indexes: [0], mode: "markdown" });

    expect(summary.recordCount).toBe(0);
    const dataset = getDataset(summary.datasetId)!;
    expect(dataset.records).toEqual([]);
    // The source still succeeded — it is readable material, not a failure.
    expect(dataset.sources[0]?.fetchedAt).toBeTruthy();
    expect(dataset.sources[0]?.error).toBeUndefined();
    expect(dataset.headline).toMatch(/no tables/i);
  });

  it("tags every row with the source it came from", async () => {
    stubNetwork({ "https://a.test/pricing": TABLE_PAGE });
    const set = registerDirectUrls("t", ["https://a.test/pricing"]);
    const summary = await runResearch({ question: "q", sourceSetId: set.id, indexes: [0], mode: "markdown" });

    const dataset = getDataset(summary.datasetId)!;
    const sourceId = dataset.sources[0]!.id;
    expect(dataset.records.every((r) => r._source === sourceId)).toBe(true);
  });
});

describe("retrieval modes", () => {
  it("crawl mode follows the site and still parses tables", async () => {
    const { calls } = stubNetwork({ "https://a.test/docs": TABLE_PAGE });
    const set = registerDirectUrls("t", ["https://a.test/docs"]);
    const summary = await runResearch({
      question: "q",
      sourceSetId: set.id,
      indexes: [0],
      mode: "crawl",
      crawlPages: 3,
    });

    expect(calls.some((u) => u.includes("/web/crawl"))).toBe(true);
    expect(summary.recordCount).toBe(3);
  });

  it("images mode de-duplicates and drops data URIs", async () => {
    stubNetwork({ "https://a.test/gallery": PROSE_PAGE });
    const set = registerDirectUrls("t", ["https://a.test/gallery"]);
    const summary = await runResearch({ question: "q", sourceSetId: set.id, indexes: [0], mode: "images" });

    const dataset = getDataset(summary.datasetId)!;
    expect(dataset.images).toHaveLength(1);
    expect(dataset.images?.[0]).toMatchObject({ src: "https://cdn.test/a.png", alt: "A" });
    expect(dataset.images?.[0]?.sourceId).toBe(dataset.sources[0]?.id);
  });
});

describe("failure isolation", () => {
  it("a failed source degrades instead of taking the run down", async () => {
    const onSourceFailed = vi.fn();
    stubNetwork({ "https://good.test/p": TABLE_PAGE });
    const set = registerDirectUrls("t", ["https://good.test/p", "https://missing.test/p"]);

    const hooks: ResearchHooks = { onSourceFailed };
    const summary = await runResearch(
      { question: "q", sourceSetId: set.id, indexes: [0, 1], mode: "markdown" },
      hooks,
    );

    expect(summary.recordCount).toBe(3);
    const dataset = getDataset(summary.datasetId)!;
    expect(dataset.sources.find((s) => s.url.includes("missing"))?.error).toBeTruthy();
    expect(dataset.sources.find((s) => s.url.includes("good"))?.error).toBeUndefined();
    expect(onSourceFailed).toHaveBeenCalled();
  });

  it("resolves with a usable summary when every source fails", async () => {
    stubNetwork({});
    const set = registerDirectUrls("t", ["https://a.test/x", "https://b.test/y"]);
    const summary = await runResearch({ question: "q", sourceSetId: set.id, indexes: [0, 1], mode: "markdown" });

    expect(summary.recordCount).toBe(0);
    expect(summary.headline).toMatch(/Could not read/i);
  });

  it("a hook that throws does not take the run down with it", async () => {
    stubNetwork({ "https://a.test/pricing": TABLE_PAGE });
    const set = registerDirectUrls("t", ["https://a.test/pricing"]);

    const summary = await runResearch(
      { question: "q", sourceSetId: set.id, indexes: [0], mode: "markdown" },
      {
        onSourceRead: () => {
          throw new Error("hook exploded");
        },
      },
    );
    expect(summary.recordCount).toBe(3);
  });
});

describe("the summary stays small", () => {
  it("returns counts and field names, never the rows themselves", async () => {
    const many = ["| Name | Value |", "| --- | --- |", ...Array.from({ length: 200 }, (_, i) => `| Row ${i} | ${i} |`)].join("\n");
    stubNetwork({ "https://a.test/big": many });
    const set = registerDirectUrls("t", ["https://a.test/big"]);

    const summary = await runResearch({ question: "q", sourceSetId: set.id, indexes: [0], mode: "markdown" });

    expect(summary.recordCount).toBe(200);
    // The dataset never travels through the model; only this summary does.
    expect(JSON.stringify(summary).length).toBeLessThan(1200);
    expect(JSON.stringify(summary)).not.toContain("Row 100");
  });
});

describe("deepenResearch", () => {
  it("extends the dataset in place so mounted components see the new rows", async () => {
    stubNetwork({ "https://a.test/pricing": TABLE_PAGE });
    const set = registerDirectUrls("t", ["https://a.test/pricing"]);
    const initial = await runResearch({ question: "q", sourceSetId: set.id, indexes: [0], mode: "markdown" });

    const deepened = await deepenResearch({ datasetId: initial.datasetId, angle: "another angle" });

    // Same id: a fresh one would leave the canvas pointing at stale data until the
    // agent rebuilt the whole dashboard, which remounts every chart.
    expect(deepened.datasetId).toBe(initial.datasetId);
    expect(getDataset(initial.datasetId)!.records.length).toBeGreaterThan(3);
  });

  it("does not flip an already-successful source to failed when the re-read fails", async () => {
    // A URL of its own: the scrape/crawl cache is module-level and lives for the
    // whole file, so reusing another test's URL would serve this deepen from a warm
    // entry and never exercise the failure at all.
    stubNetwork({ "https://reread.test/pricing": TABLE_PAGE });
    const set = registerDirectUrls("t", ["https://reread.test/pricing"]);
    const initial = await runResearch({ question: "q", sourceSetId: set.id, indexes: [0], mode: "markdown" });

    // Now everything fails.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "server error" }, 500)),
    );
    await deepenResearch({ datasetId: initial.datasetId, angle: "again" });

    const dataset = getDataset(initial.datasetId)!;
    expect(dataset.sources[0]?.fetchedAt).toBeTruthy();
    expect(dataset.sources[0]?.error).toBeUndefined();
    expect(dataset.records).toHaveLength(3);
  });
});
