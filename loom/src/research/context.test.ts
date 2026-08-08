import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FieldSpec } from "../contract/dataset.js";
import { extractStructured, getBrand, scrapeMarkdown } from "./context.js";

/**
 * All network access is stubbed. Response shapes mirror the ones confirmed against
 * the live context.dev API (see the header comment in context.ts).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const FIELDS: FieldSpec[] = [{ key: "price", label: "Price", type: "currency", unit: "AED" }];

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("extractStructured — timeout budget", () => {
  it("does not abort a request that takes the full measured ~22s to resolve", async () => {
    vi.useFakeTimers();

    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve;
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = extractStructured("https://slow.test/pricing", FIELDS);

    // The real API is measured at ~22s per URL. A 20s budget — the value this
    // repo shipped with — would have aborted every real extraction before it
    // finished. Advancing exactly to that measured latency without an abort
    // firing is the whole point of this test.
    await vi.advanceTimersByTimeAsync(22_000);
    resolveFetch(jsonResponse({ status: "ok", data: { records: [{ price: 100 }] } }));

    await expect(promise).resolves.toEqual([{ price: 100 }]);
  });

  it("still aborts eventually, so a genuinely hung request does not stall the run forever", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = extractStructured("https://hung.test/pricing", FIELDS);
    promise.catch(() => {
      // expected — assert via rejects below, this just keeps Node's unhandled
      // rejection detector quiet about the same rejection observed twice.
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).rejects.toThrow();
  });
});

describe("extractStructured — malformed responses", () => {
  it("does not fabricate a record out of an all-null salvage when the array wrapper is missing", async () => {
    // The model occasionally returns `data` without the `records` array wrapper.
    // If none of the requested fields are actually present, the salvage path must
    // report zero records rather than a record that is null in every column —
    // that would count as "found a row" when nothing was actually read.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "ok", data: { unrelated: "field" } })),
    );

    const records = await extractStructured("https://example.test/page", FIELDS);
    expect(records).toEqual([]);
  });

  it("still salvages a single row when the fields come back unwrapped but populated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "ok", data: { price: 42 } })),
    );

    const records = await extractStructured("https://example.test/page", FIELDS);
    expect(records).toEqual([{ price: 42 }]);
  });

  it("throws ContextApiError with the real status on a 401/USAGE_EXCEEDED response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ message: "credits have been completely depleted", error_code: "USAGE_EXCEEDED" }, 401),
      ),
    );

    await expect(extractStructured("https://example.test/page", FIELDS)).rejects.toMatchObject({
      name: "ContextApiError",
      status: 401,
    });
  });

  it("throws ContextApiError with the real status on a 404/NOT_FOUND response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Target page returned a 404", error_code: "NOT_FOUND" }, 404)),
    );

    await expect(extractStructured("https://example.test/page", FIELDS)).rejects.toMatchObject({
      name: "ContextApiError",
      status: 404,
    });
  });
});

describe("scrapeMarkdown / getBrand — no API key ever leaves this module", () => {
  it("never sends an Authorization header — the dev proxy injects it server-side", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization ?? headers?.authorization).toBeUndefined();
      return jsonResponse({ success: true, markdown: "# ok" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await scrapeMarkdown("https://example.test/page");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("resolves brand info from a well-formed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "ok",
          brand: { title: "Example Co", logos: [{ url: "https://example.test/logo.png" }], colors: [{ hex: "#123456" }] },
        }),
      ),
    );

    const brand = await getBrand("example.test");
    expect(brand).toEqual({ name: "Example Co", logoUrl: "https://example.test/logo.png", color: "#123456" });
  });
});
