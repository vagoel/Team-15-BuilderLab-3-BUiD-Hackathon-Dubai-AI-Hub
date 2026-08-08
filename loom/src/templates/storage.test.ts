import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportTemplate } from "../contract/index.js";
import { loadSelectedId, loadTemplates, saveSelectedId, saveTemplates, TemplateStorageError } from "./storage.js";

const TEMPLATES_KEY = "loom:templates:v1";

/**
 * The test environment is plain Node — no DOM, so no `localStorage`. Storage is the
 * entire subject of this file, so stub the real interface rather than skipping it.
 */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(globalThis, "Storage", { value: MemoryStorage, configurable: true });
}

function template(id: string, name = id): ReportTemplate {
  return {
    version: 1,
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columns: 12,
    slots: [{ slotId: "chart_1", kind: "chart", order: 0, options: { chartKind: "bar" } }],
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("templates round-trip", () => {
  it("saves and reads back", () => {
    saveTemplates([template("tpl_1", "Comparison")]);
    expect(loadTemplates().map((t) => t.name)).toEqual(["Comparison"]);
  });

  it("remembers the selection, and clearing it", () => {
    saveSelectedId("tpl_1");
    expect(loadSelectedId()).toBe("tpl_1");
    saveSelectedId(null);
    expect(loadSelectedId()).toBeNull();
  });
});

describe("corrupt storage degrades safely", () => {
  // localStorage outlives builds, so newer code will eventually read an entry
  // written by older code, hand-edited, or half-written by a failed quota write.
  it("survives malformed JSON", () => {
    localStorage.setItem(TEMPLATES_KEY, "{not json");
    expect(loadTemplates()).toEqual([]);
  });

  it("survives a value that is not an array", () => {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify({ nope: true }));
    expect(loadTemplates()).toEqual([]);
  });

  it("drops only the entries that fail validation", () => {
    localStorage.setItem(
      TEMPLATES_KEY,
      JSON.stringify([template("tpl_ok"), { version: 99, id: "future" }, { junk: true }]),
    );
    expect(loadTemplates().map((t) => t.id)).toEqual(["tpl_ok"]);
  });

  it("refuses to load an entry that smuggled report data in", () => {
    const bad = { ...template("tpl_bad"), slots: [{ slotId: "s1", kind: "chart", order: 0, datasetId: "ds_1" }] };
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify([bad, template("tpl_good")]));
    expect(loadTemplates().map((t) => t.id)).toEqual(["tpl_good"]);
  });

  it("survives localStorage being unavailable entirely", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    expect(loadTemplates()).toEqual([]);
    expect(loadSelectedId()).toBeNull();
  });

  it("reports a quota failure rather than pretending the save worked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveTemplates([template("tpl_1")])).toThrow(TemplateStorageError);
  });

  it("never lets a failed selection write throw at the caller", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    // The selection still applies for this page — it just will not survive a reload,
    // which is not worth interrupting the user over.
    expect(() => saveSelectedId("tpl_1")).not.toThrow();
  });
});

describe("write-side guards", () => {
  it("refuses to persist a template carrying data bindings", () => {
    const bad = { ...template("tpl_bad"), slots: [{ slotId: "s1", kind: "chart", order: 0, datasetId: "ds_1" }] };
    expect(() => saveTemplates([bad as unknown as ReportTemplate])).toThrow(/data-bound/);
  });

  it("caps how many templates are kept", () => {
    saveTemplates(Array.from({ length: 40 }, (_, i) => template(`tpl_${i}`)));
    expect(loadTemplates().length).toBeLessThanOrEqual(30);
  });
});
