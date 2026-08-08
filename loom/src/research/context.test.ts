import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crawlSite, getBrand, scrapeImages, scrapeMarkdown, searchWeb } from "./context.js";

/**
 * All network access is stubbed. Response shapes mirror the ones confirmed against
 * the live context.dev API (see the header comment in context.ts).
 */

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Extract endpoint is gone", () => {
  it("exports no structured-extraction entry point", async () => {
    const mod = await import("./context.js");
    expect(Object.keys(mod)).not.toContain("extractStructured");
  });

  it("never requests /web/extract from any raw client", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        const u = String(url);
        if (u.includes("/web/search")) return jsonResponse({ results: [] });
        if (u.includes("/web/crawl")) return jsonResponse({ results: [] });
        if (u.includes("/web/scrape/images")) return jsonResponse({ success: true, images: [] });
        return jsonResponse({ success: true, markdown: "# ok" });
      }),
    );

    await searchWeb("anything");
    await scrapeMarkdown("https://a.test");
    await crawlSite("https://a.test", 2);
    await scrapeImages("https://a.test");

    expect(urls.some((u) => u.includes("/web/extract"))).toBe(false);
  });
});

describe("searchWeb", () => {
  it("discovers candidates without asking for inline markdown", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(String(url)).toContain("/web/search");
        body = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({
          query: "q",
          results: [
            {
              url: "https://en.wikipedia.org/wiki/A",
              title: "A — Wikipedia",
              description: "About A.",
              relevance: "high",
              markdown: { markdown: null, code: "NOT_REQUESTED" },
            },
          ],
          key_metadata: { credits_consumed: 1, credits_remaining: 9 },
        });
      }),
    );

    const hits = await searchWeb("q");

    // Discovery and retrieval stay separate: scraping ten pages to read three is
    // exactly the spend this split exists to avoid.
    expect(body.markdownOptions).toEqual({ enabled: false });
    expect(body.numResults).toBe(10);
    expect(hits).toEqual([
      {
        url: "https://en.wikipedia.org/wiki/A",
        title: "A — Wikipedia",
        description: "About A.",
        relevance: "high",
      },
    ]);
  });

  it("raises the caller's request to the API minimum of 10", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({ results: [] });
      }),
    );

    await searchWeb("q", 3);
    expect(body.numResults).toBe(10);
  });

  it("skips result entries with no usable url instead of failing the search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ results: [{ title: "no url here" }, { url: "https://b.test", title: "B" }] })),
    );

    const hits = await searchWeb("q");
    expect(hits).toEqual([{ url: "https://b.test", title: "B", description: undefined, relevance: undefined }]);
  });
});

describe("crawlSite", () => {
  it("normalizes crawl results and clamps the page budget", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        body = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({
          results: [
            {
              markdown: "# Example Domain\n\nBody.",
              metadata: { sourceUrl: "https://example.com/", finalUrl: "https://example.com/", title: "Example Domain", crawlDepth: 0 },
            },
          ],
        });
      }),
    );

    // The agent wrote this number; it is billed per page, so it is clamped here.
    const pages = await crawlSite("https://example.com", 999);

    expect(body.limit).toBe(12);
    expect(pages).toEqual([
      { url: "https://example.com/", title: "Example Domain", markdown: "# Example Domain\n\nBody.", depth: 0 },
    ]);
  });
});

describe("scrapeImages", () => {
  it("keeps src, alt and element and drops entries with no src", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          success: true,
          images: [
            { src: "https://x.test/a.png", element: "img", type: "url", alt: "An A" },
            { element: "img", alt: "no src" },
          ],
          url: "https://x.test",
        }),
      ),
    );

    const images = await scrapeImages("https://x.test");
    expect(images).toEqual([{ src: "https://x.test/a.png", alt: "An A", element: "img" }]);
  });
});

describe("retry policy", () => {
  it("retries a 503 once and succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? jsonResponse({ message: "upstream" }, 503) : jsonResponse({ success: true, markdown: "# ok" });
      }),
    );

    await expect(scrapeMarkdown("https://a.test")).resolves.toBe("# ok");
    expect(calls).toBe(2);
  });

  it("does not retry a 401 — the same credential fails the same way", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ message: "depleted", error_code: "USAGE_EXCEEDED" }, 401);
      }),
    );

    await expect(scrapeMarkdown("https://a.test")).rejects.toMatchObject({ name: "ContextApiError", status: 401 });
    expect(calls).toBe(1);
  });

  it("does not retry a 404 — the page does not exist on a second look either", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ message: "not found" }, 404);
      }),
    );

    await expect(scrapeMarkdown("https://a.test")).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(1);
  });

  it("carries Retry-After through on a 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "slow down" }, 429, { "retry-after": "1" })),
    );

    await expect(scrapeMarkdown("https://a.test")).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 1,
    });
  });
});

describe("no API key ever leaves this module", () => {
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
