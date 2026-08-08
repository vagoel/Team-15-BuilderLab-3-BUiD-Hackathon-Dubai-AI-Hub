import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldSpec } from "../contract/dataset.js";
import { useLoom } from "../store.js";
import { cached } from "./cache.js";
import { deepenResearch, getDataset, runResearch, type ResearchHooks } from "./index.js";

/**
 * All network access is stubbed — these tests never touch the real context.dev
 * API. See context.ts for the request/response shapes these mocks emulate,
 * confirmed against the live API before this file was written.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function deferredResponse(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const priceAndName: FieldSpec[] = [
  { key: "price", label: "Price", type: "currency", unit: "AED" },
  { key: "name", label: "Name", type: "string" },
];

/** A two-source run: one URL that succeeds cleanly, one that fails at every layer. */
async function runMixedResearch(hooks?: ResearchHooks) {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes("/web/extract")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { url: string };
      if (body.url.includes("bad.test")) {
        return jsonResponse({ message: "bad url", error_code: "WEBSITE_ACCESS_ERROR" }, 400);
      }
      return jsonResponse({ status: "ok", data: { records: [{ price: 500, name: "Good" }] } });
    }
    if (u.includes("/web/scrape/markdown")) {
      if (u.includes("bad.test")) throw new Error("network down");
      return jsonResponse({ success: true, markdown: "# ok" });
    }
    if (u.includes("/brand/retrieve")) {
      return jsonResponse({ message: "no brand", error_code: "INPUT_VALIDATION_ERROR" }, 400);
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const summary = await runResearch(
    {
      question: "Test question",
      seedUrls: ["https://good.test/1", "https://bad.test/1"],
      fields: priceAndName,
    },
    hooks,
  );
  const dataset = getDataset(summary.datasetId);
  if (!dataset) throw new Error("dataset missing from store after runResearch");
  return { summary, dataset, fetchMock };
}

beforeEach(() => {
  useLoom.getState().reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runResearch — parallel fetching", () => {
  it("issues every source's request before any of them resolves", async () => {
    const seedUrls = ["https://a.test/1", "https://b.test/2", "https://c.test/3"];
    const calls: string[] = [];
    const pending: Array<ReturnType<typeof deferredResponse>> = [];

    const fetchMock = vi.fn((url: unknown) => {
      calls.push(String(url));
      const d = deferredResponse();
      pending.push(d);
      return d.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = runResearch({ question: "parallel test", seedUrls, fields: priceAndName });

    // Synchronously (before we resolve anything) every source's first request
    // must already have been dispatched — proof this is Promise.allSettled
    // fan-out, not a sequential await chain. The first request per source is the
    // markdown scrape, which is tier 1 of processSource.
    const scrapeCalls = calls.filter((u) => u.includes("/web/scrape/markdown"));
    expect(scrapeCalls.length).toBe(seedUrls.length);
    expect(pending.length).toBeGreaterThanOrEqual(seedUrls.length);
    expect(pending.every((_, i) => calls[i] !== undefined)).toBe(true);

    // Now let everything settle. `pending` keeps growing as each source falls
    // from the scrape tier through to extract, so this drains wave by wave and
    // re-reads pending.length every iteration rather than snapshotting it.
    for (let i = 0; i < pending.length; i++) {
      const url = calls[i] ?? "";
      const entry = pending[i];
      if (!entry) continue;
      if (url.includes("/web/extract")) {
        entry.resolve(jsonResponse({ status: "ok", data: { records: [{ price: 1, name: "x" }] } }));
      } else if (url.includes("/web/scrape/markdown")) {
        // No tables on this page — the source falls through to the extract tier.
        entry.resolve(jsonResponse({ success: true, markdown: "# prose only" }));
      } else {
        entry.resolve(jsonResponse({ message: "no brand" }, 400));
      }
      // Give the settled promise a turn so the next tier's fetch is dispatched
      // and appended to `pending` before the loop looks again.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const summary = await resultPromise;
    expect(summary.recordCount).toBe(seedUrls.length);
    expect(summary.sourceCount).toBe(seedUrls.length);
  });
});

describe("runResearch — degradation", () => {
  it("degrades a failing source instead of throwing, and still resolves", async () => {
    const onSourceFailed = vi.fn();
    const { dataset } = await runMixedResearch({ onSourceFailed });

    const failedSource = dataset.sources.find((s) => s.url.includes("bad.test"));
    const okSource = dataset.sources.find((s) => s.url.includes("good.test"));

    expect(failedSource?.error).toBeTruthy();
    expect(failedSource?.fetchedAt).toBeUndefined();
    expect(okSource?.fetchedAt).toBeTruthy();
    expect(okSource?.error).toBeUndefined();
    expect(onSourceFailed).toHaveBeenCalledTimes(1);
  });

  it("tags every record with the id of the source it came from", async () => {
    const { dataset } = await runMixedResearch();
    expect(dataset.records.length).toBeGreaterThan(0);
    for (const record of dataset.records) {
      expect(typeof record._source).toBe("string");
      expect(dataset.sources.some((s) => s.id === record._source)).toBe(true);
    }
  });

  it("generates findings mechanically — no LLM call in this path", async () => {
    const { dataset } = await runMixedResearch();
    expect(dataset.findings.length).toBeGreaterThanOrEqual(2);
    expect(dataset.findings.length).toBeLessThanOrEqual(6);
    for (const f of dataset.findings) expect(f.text.length).toBeGreaterThan(0);
    expect(dataset.headline.length).toBeGreaterThan(0);
  });

  it("writes the dataset into the zustand store, readable via getDataset", async () => {
    const { summary, dataset } = await runMixedResearch();
    expect(getDataset(summary.datasetId)).toBe(dataset);
    expect(useLoom.getState().datasets[summary.datasetId]).toBe(dataset);
  });
});

describe("runResearch — small summary payload", () => {
  it("keeps the returned summary small no matter how many rows were pulled", async () => {
    const seedUrls = Array.from({ length: 8 }, (_, i) => `https://many.test/${i}`);
    const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/web/extract")) {
        const records = Array.from({ length: 20 }, (_, j) => ({
          price: j * 1000,
          name: `A fairly long listing description for row ${j} `.repeat(3),
        }));
        return jsonResponse({ status: "ok", data: { records } });
      }
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runResearch({ question: "big run", seedUrls, fields: priceAndName });

    expect(summary.recordCount).toBe(seedUrls.length * 20);
    expect(JSON.stringify(summary).length).toBeLessThan(2000);
  });
});

describe("runResearch — total failure still resolves", () => {
  it("resolves with a usable summary when every source fails", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new Error("network unreachable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runResearch({
      question: "everything fails",
      seedUrls: ["https://down.test/1", "https://down.test/2"],
      fields: priceAndName,
    });

    expect(summary.recordCount).toBe(0);
    expect(summary.headline.length).toBeGreaterThan(0);
    const dataset = getDataset(summary.datasetId);
    expect(dataset?.sources.every((s) => s.error)).toBe(true);
  });
});

describe("cached()", () => {
  it("returns cached:false then cached:true for the same key", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { n: calls };
    };

    const first = await cached("unit-test-cache-key", 60_000, fn);
    const second = await cached("unit-test-cache-key", 60_000, fn);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(calls).toBe(1);
  });
});

/**
 * The heuristic markdown fallback is the single riskiest path in this file: it is
 * the only place capable of manufacturing a row that *looks* like real data but
 * describes nothing that was actually read. Every scenario below was previously
 * unexercised — extraction always "succeeded" in tests before this file, because
 * the real key was out of credits during the whole build.
 */
describe("runResearch — heuristic fallback is not used where there is definitively nothing to read", () => {
  it("stops after the scrape on a 404 — the page does not exist on either endpoint", async () => {
    // The scrape is tier 1, so a definitive status arrives there first. Spending
    // the ~22s extract budget afterwards buys a guaranteed second failure.
    let extractCalls = 0;
    const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/web/extract")) {
        extractCalls += 1;
        return jsonResponse({ message: "Target page returned a 404", error_code: "NOT_FOUND" }, 404);
      }
      if (u.includes("/web/scrape/markdown")) {
        return jsonResponse({ message: "Target page returned a 404", error_code: "NOT_FOUND" }, 404);
      }
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runResearch({
      question: "404 test",
      seedUrls: ["https://dead-404.test/page"],
      fields: priceAndName,
    });

    expect(extractCalls).toBe(0);
    expect(summary.recordCount).toBe(0);
    const dataset = getDataset(summary.datasetId)!;
    expect(dataset.sources[0]?.error).toBeTruthy();
    expect(dataset.sources[0]?.fetchedAt).toBeUndefined();
  });

  it("stops after the scrape on a 401 — the key has no credits left on either endpoint", async () => {
    let extractCalls = 0;
    const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/web/extract")) {
        extractCalls += 1;
        return jsonResponse({ message: "credits have been completely depleted", error_code: "USAGE_EXCEEDED" }, 401);
      }
      if (u.includes("/web/scrape/markdown")) {
        return jsonResponse({ message: "credits have been completely depleted", error_code: "USAGE_EXCEEDED" }, 401);
      }
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runResearch({
      question: "401 test",
      seedUrls: ["https://depleted-401.test/page"],
      fields: priceAndName,
    });

    expect(extractCalls).toBe(0);
    expect(summary.recordCount).toBe(0);
    const dataset = getDataset(summary.datasetId)!;
    expect(dataset.sources[0]?.error).toBeTruthy();
  });

  it("still refuses to fabricate a row when only the extract path returns 401", async () => {
    // A scrape that succeeds while extract 401s must not reach the heuristic —
    // that is the path that manufactures a row describing nothing that was read.
    const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/web/extract")) {
        return jsonResponse({ message: "credits have been completely depleted", error_code: "USAGE_EXCEEDED" }, 401);
      }
      if (u.includes("/web/scrape/markdown")) {
        return jsonResponse({ success: true, markdown: "# Should never be read\n\nPrice: 1\nName: ghost\n".repeat(3) });
      }
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runResearch({
      question: "401 extract only",
      seedUrls: ["https://depleted-401.test/page"],
      fields: priceAndName,
    });

    expect(summary.recordCount).toBe(0);
    expect(getDataset(summary.datasetId)!.sources[0]?.error).toBeTruthy();
  });

  it("does fall back and extracts a real row on a plausibly transient failure (5xx)", async () => {
    const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/web/extract")) return jsonResponse({ message: "server error" }, 500);
      if (u.includes("/web/scrape/markdown")) {
        return jsonResponse({
          success: true,
          markdown:
            "# Widget Co\n\nPrice: AED 75\nName: Widget Pro\nSome additional descriptive filler copy so the " +
            "page clears the substantive-content threshold for the fallback path to run at all.\n",
        });
      }
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runResearch({
      question: "fallback test",
      seedUrls: ["https://retry-500.test/page"],
      fields: priceAndName,
    });

    expect(summary.recordCount).toBe(1);
    const dataset = getDataset(summary.datasetId)!;
    expect(dataset.sources[0]?.error).toBeUndefined();
    expect(dataset.sources[0]?.fetchedAt).toBeTruthy();
    expect(dataset.records[0]).toMatchObject({ price: 75, name: "Widget Pro" });
  });

  it("does not fabricate a record when the scraped fallback content is too thin to trust", async () => {
    const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/web/extract")) return jsonResponse({ message: "server error" }, 500);
      if (u.includes("/web/scrape/markdown")) return jsonResponse({ success: true, markdown: "# 404\nNot found" });
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runResearch({
      question: "thin content test",
      seedUrls: ["https://thin-scrape.test/page"],
      fields: priceAndName,
    });

    expect(summary.recordCount).toBe(0);
    const dataset = getDataset(summary.datasetId)!;
    expect(dataset.sources[0]?.error).toBeTruthy();
  });

  it("does not fabricate a record when none of the requested fields' labels appear on the scraped page", async () => {
    const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/web/extract")) return jsonResponse({ message: "server error" }, 500);
      if (u.includes("/web/scrape/markdown")) {
        return jsonResponse({
          success: true,
          markdown:
            "# About Us\n\nWe build durable outdoor equipment for climbers and hikers across " +
            "difficult alpine terrain, tested through many seasons of continuous field use.\n",
        });
      }
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const summary = await runResearch({
      question: "no match test",
      seedUrls: ["https://no-match.test/page"],
      fields: priceAndName,
    });

    expect(summary.recordCount).toBe(0);
    const dataset = getDataset(summary.datasetId)!;
    expect(dataset.sources[0]?.error).toBeTruthy();
  });
});

describe("runResearch — extract cache key uniqueness", () => {
  it("treats two field schemas that differ only by currency unit as different requests", async () => {
    let extractCalls = 0;
    const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/web/extract")) {
        extractCalls += 1;
        return jsonResponse({ status: "ok", data: { records: [{ price: 10 }] } });
      }
      if (u.includes("/web/scrape/markdown")) return jsonResponse({ success: true, markdown: "# ok" });
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = "https://cache-key-unit.test/page";
    const fieldsAed: FieldSpec[] = [{ key: "price", label: "Price", type: "currency", unit: "AED" }];
    const fieldsUsd: FieldSpec[] = [{ key: "price", label: "Price", type: "currency", unit: "USD" }];

    await runResearch({ question: "q1", seedUrls: [url], fields: fieldsAed });
    await runResearch({ question: "q2", seedUrls: [url], fields: fieldsUsd });

    // Before the fix, the cache key only encoded key:type, so the second call
    // would have been served the first call's (wrong-unit) cached result instead
    // of making its own request.
    expect(extractCalls).toBe(2);
  });
});

describe("deepenResearch — preserves prior source success", () => {
  it("does not flip an already-successful source to failed when its deepen re-fetch fails", async () => {
    const url = "https://deepen-preserve.test/page";

    // First pass: this source succeeds cleanly and contributes one record.
    const firstFetch = vi.fn(async (u: unknown): Promise<Response> => {
      const s = String(u);
      if (s.includes("/web/extract")) {
        return jsonResponse({ status: "ok", data: { records: [{ price: 40, name: "Original" }] } });
      }
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", firstFetch);

    const initial = await runResearch({ question: "q", seedUrls: [url], fields: priceAndName });
    const initialDataset = getDataset(initial.datasetId)!;
    expect(initialDataset.sources[0]?.fetchedAt).toBeTruthy();
    expect(initialDataset.sources[0]?.error).toBeUndefined();
    expect(initialDataset.records).toHaveLength(1);

    // Second pass (deepen, a different angle so it is not just served from cache):
    // both the structured extract and the markdown fallback fail outright.
    const secondFetch = vi.fn(async (u: unknown): Promise<Response> => {
      const s = String(u);
      if (s.includes("/web/extract")) return jsonResponse({ message: "server error" }, 500);
      if (s.includes("/web/scrape/markdown")) throw new Error("network down");
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", secondFetch);

    const deepened = await deepenResearch({ datasetId: initial.datasetId, angle: "add extra detail" });
    const deepenedDataset = getDataset(deepened.datasetId)!;

    // The source's earlier success must not be erased by a failed refetch — the
    // dataset still carries the row it originally contributed, so the source must
    // still read as succeeded rather than desyncing the counts from the records.
    expect(deepenedDataset.sources[0]?.fetchedAt).toBeTruthy();
    expect(deepenedDataset.sources[0]?.error).toBeUndefined();
    expect(deepenedDataset.records).toHaveLength(1);
    expect(deepenedDataset.records[0]).toMatchObject({ name: "Original" });
    expect(deepenedDataset.headline).toMatch(/1 record/);
  });
});

describe("runResearch — a hook that throws does not take the run down with it", () => {
  it("still resolves normally, and still records the source that a broken onSourceRead hook fired for", async () => {
    const fetchMock = vi.fn(async (url: unknown): Promise<Response> => {
      const u = String(url);
      if (u.includes("/web/extract")) return jsonResponse({ status: "ok", data: { records: [{ price: 1, name: "x" }] } });
      return jsonResponse({ message: "no brand" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const brokenHooks: ResearchHooks = {
      onStart: () => {
        throw new Error("boom in onStart");
      },
      onProgress: () => {
        throw new Error("boom in onProgress");
      },
      onSourceFound: () => {
        throw new Error("boom in onSourceFound");
      },
      onSourceRead: () => {
        throw new Error("boom in onSourceRead");
      },
    };

    const summary = await runResearch(
      { question: "hook safety", seedUrls: ["https://hook-safety.test/page"], fields: priceAndName },
      brokenHooks,
    );

    expect(summary.recordCount).toBe(1);
    const dataset = getDataset(summary.datasetId)!;
    expect(dataset.sources[0]?.fetchedAt).toBeTruthy();
  });
});
