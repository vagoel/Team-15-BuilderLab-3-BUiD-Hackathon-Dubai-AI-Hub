import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * cache.ts has no jsdom/browser sessionStorage in the default (node) vitest
 * environment, so these tests install a tiny in-memory Storage stand-in via
 * vi.stubGlobal. That is enough to exercise the real read/write paths in
 * cache.ts — nothing here is a mock of cache.ts itself.
 *
 * Each test re-imports the module fresh (vi.resetModules) so the in-memory `mem`
 * Map — a module-level singleton — starts empty, forcing reads through the
 * sessionStorage mirror rather than being served by the warm in-memory cache.
 * The fake sessionStorage instance is created once per test and lives outside
 * the module, so it survives the reset exactly the way real sessionStorage
 * survives a page reload within the same tab.
 */

function fakeSessionStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as unknown as Storage;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cached() — sessionStorage mirror", () => {
  it("serves a later, freshly-imported module instance from the sessionStorage mirror", async () => {
    vi.stubGlobal("sessionStorage", fakeSessionStorage());

    const first = await import("./cache.js");
    let calls = 0;
    const result1 = await first.cached("mirror-key", 60_000, async () => {
      calls += 1;
      return { n: 42 };
    });
    expect(result1.cached).toBe(false);

    // Simulate a page reload: a brand new module instance, so `mem` is empty again,
    // but the same sessionStorage backing store carries over.
    vi.resetModules();
    const second = await import("./cache.js");
    const result2 = await second.cached("mirror-key", 60_000, async () => {
      calls += 1;
      return { n: 999 };
    });

    expect(result2.cached).toBe(true);
    expect(result2.value).toEqual({ n: 42 });
    expect(calls).toBe(1); // fn never ran a second time
  });

  it("versions its sessionStorage keys, so a stale entry from an older build's shape is ignored rather than trusted", async () => {
    const storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);

    const { SESSION_PREFIX } = await import("./cache.js");

    // Write an entry the way an *older* build (unversioned prefix, or a build that
    // cached a different `.value` shape) would have left behind — e.g. a plain
    // string where the current build expects a DataRecord[].
    storage.setItem(
      "loom:cache:stale-key",
      JSON.stringify({ value: "an incompatible shape from an old build", ts: Date.now() }),
    );
    // Also plant a corrupted (non-JSON) entry under a versioned-looking key, to
    // confirm a parse failure is treated as a miss rather than thrown.
    storage.setItem(`${SESSION_PREFIX}corrupt-key`, "{not json");

    const { cached } = await import("./cache.js");

    let calls = 0;
    const fresh = async () => {
      calls += 1;
      return { real: true };
    };

    const staleResult = await cached("stale-key", 60_000, fresh);
    expect(staleResult.cached).toBe(false); // old unversioned entry is invisible, not trusted
    expect(staleResult.value).toEqual({ real: true });

    const corruptResult = await cached("corrupt-key", 60_000, fresh);
    expect(corruptResult.cached).toBe(false); // corrupt JSON degrades to a miss, doesn't throw
    expect(corruptResult.value).toEqual({ real: true });

    expect(calls).toBe(2);
  });

  it("survives a sessionStorage quota/write error without losing the in-memory value", async () => {
    const storage = fakeSessionStorage();
    storage.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    vi.stubGlobal("sessionStorage", storage);

    const { cached } = await import("./cache.js");

    const result = await cached("quota-key", 60_000, async () => "value survives");
    expect(result.value).toBe("value survives");
    expect(result.cached).toBe(false);

    // The in-memory cache (same module instance) still serves it on a second call.
    const second = await cached("quota-key", 60_000, async () => "should not run");
    expect(second.cached).toBe(true);
    expect(second.value).toBe("value survives");
  });

  it("never caches a failure — a rejected fn must not poison the next call", async () => {
    vi.stubGlobal("sessionStorage", fakeSessionStorage());
    const { cached } = await import("./cache.js");

    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient failure");
      return "recovered";
    };

    await expect(cached("flaky-key", 60_000, flaky)).rejects.toThrow("transient failure");
    const result = await cached("flaky-key", 60_000, flaky);
    expect(result.value).toBe("recovered");
    expect(result.cached).toBe(false);
    expect(calls).toBe(2);
  });
});
