import { describe, expect, it } from "vitest";
import { csvToTable, parseCsv, toNumber } from "./csv.js";

describe("csvToTable — type inference", () => {
  it("infers currency and number columns from clean values", () => {
    const csv = "plan,price_usd,seats\nStarter,29,3\nTeam,99,10\nBusiness,249,50\n";
    const { fields, records } = csvToTable(csv, "src_1");

    expect(fields.find((f) => f.key === "price_usd")?.type).toBe("currency");
    expect(fields.find((f) => f.key === "seats")?.type).toBe("number");
    expect(records[0]?.price_usd).toBe(29);
    expect(records[0]?.seats).toBe(3);
  });

  it("does not mistake a numeric column for text just because sample cells carry padding whitespace", () => {
    // A common artifact of copy-pasted/exported spreadsheet data: cells with
    // incidental leading/trailing whitespace. inferType used to test the raw,
    // untrimmed sample text while the actual record-building pass trimmed it —
    // so a whitespace-padded numeric/date/url column would be inferred as
    // "string" (untestable regex match) even though every value parses cleanly
    // once trimmed, exactly the way it is trimmed a few lines later.
    // ("count" rather than "revenue" deliberately — the latter is in the
    // money-name allowlist and would infer as "currency" regardless.)
    const csv = 'count,released,homepage\n" 1200 ",2026-01-05 ," https://a.test "\n" 950",2026-02-10, https://b.test\n';
    const { fields, records } = csvToTable(csv, "src_1");

    expect(fields.find((f) => f.key === "count")?.type).toBe("number");
    expect(fields.find((f) => f.key === "released")?.type).toBe("date");
    expect(fields.find((f) => f.key === "homepage")?.type).toBe("url");

    expect(records[0]?.count).toBe(1200);
    expect(records[1]?.count).toBe(950);
  });

  it("still falls back to string for a column that only coincidentally has one or two numeric-looking cells", () => {
    const csv = "id\nSKU-1\nSKU-2\nSKU-3\n";
    const { fields } = csvToTable(csv, "src_1");
    expect(fields.find((f) => f.key === "id")?.type).toBe("string");
  });
});

describe("toNumber", () => {
  it("strips thousands separators and currency marks", () => {
    expect(toNumber("$1,234.50")).toBe(1234.5);
    expect(toNumber("-42")).toBe(-42);
    expect(toNumber("")).toBeNull();
    expect(toNumber("-")).toBeNull();
  });
});

describe("parseCsv", () => {
  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const { header, rows } = parseCsv('a,b\n"1,000","she said ""hi"""\n');
    expect(header).toEqual(["a", "b"]);
    expect(rows).toEqual([["1,000", 'she said "hi"']]);
  });
});
