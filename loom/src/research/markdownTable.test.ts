import { describe, expect, it } from "vitest";
import type { FieldSpec } from "../contract/dataset.js";
import { cleanCell, parseMarkdownTables, recordsFromMarkdown } from "./markdownTable.js";

/**
 * Fixtures mirror what context.dev's /web/scrape/markdown actually returns for the
 * Wikipedia "Academy Award for Best Actor" page — including the rowspan-flattened
 * ragged rows and parenthesised link targets that broke naive parsing.
 */

const winnerFields: FieldSpec[] = [
  { key: "year", label: "Year", type: "string" },
  { key: "actor", label: "Actor", type: "string" },
  { key: "film", label: "Film", type: "string" },
];

describe("cleanCell", () => {
  it("keeps link text and drops the target", () => {
    expect(cleanCell("[Richard Barthelmess](https://en.wikipedia.org/wiki/Richard_Barthelmess)")).toBe(
      "Richard Barthelmess",
    );
  });

  it("survives parentheses inside the link target", () => {
    // The naive /\(.*?\)/ form terminates at `(1927_film)` and leaks `'title')`.
    const raw = "_[The Way of All Flesh](https://en.wikipedia.org/wiki/The_Way_of_All_Flesh_(1927_film) 'The Way of All Flesh (1927 film)')_";
    expect(cleanCell(raw)).toBe("The Way of All Flesh");
  });

  it("strips emphasis, citation markers and winner daggers", () => {
    expect(cleanCell("**Emil Jannings** ‡[\\[7\\]](https://example.com/#cite)")).toBe("Emil Jannings");
    expect(cleanCell("Warner Baxter [\\[note 1\\]](https://example.com/#n)")).toBe("Warner Baxter");
  });

  it("turns <br> into a space rather than joining words", () => {
    expect(cleanCell("1927/28<br>(1st)")).toBe("1927/28 (1st)");
  });
});

describe("parseMarkdownTables", () => {
  it("reads a plain table", () => {
    const md = ["| Year | Actor |", "| --- | --- |", "| 1994 | Tom Hanks |", "| 1995 | Nicolas Cage |"].join("\n");
    const [table] = parseMarkdownTables(md);
    expect(table?.headers).toEqual(["Year", "Actor"]);
    expect(table?.rows).toHaveLength(2);
  });

  it("realigns rowspan-flattened rows by carrying leading columns forward", () => {
    // Row 2 dropped Year+Actor (both spanned); row 3 dropped only Year.
    const md = [
      "| Year | Actor | Role(s) | Film |",
      "| --- | --- | --- | --- |",
      "| 1927/28 | Emil Jannings | Sergius | The Last Command |",
      "| August Schilling | The Way of All Flesh |",
      "| Richard Barthelmess | Nickie Elkins | The Noose |",
    ].join("\n");
    const [table] = parseMarkdownTables(md);

    expect(table?.rows[1]).toEqual(["1927/28", "Emil Jannings", "August Schilling", "The Way of All Flesh"]);
    expect(table?.rows[2]).toEqual(["1927/28", "Richard Barthelmess", "Nickie Elkins", "The Noose"]);
  });

  it("does not shift ragged rows into a trailing reference column", () => {
    // Year and Ref both span the year-group, so nominee rows are missing a cell
    // at each end. Treating the gap as leading-only put roles into Film.
    const md = [
      "| Year | Actor | Role(s) | Film | Ref. |",
      "| --- | --- | --- | --- | --- |",
      "| 1927/28 | Emil Jannings | Sergius | The Last Command | [\\[7\\]](https://x.test/#c) |",
      "| Richard Barthelmess | Nickie Elkins | The Noose |",
      "| Patent Leather Kid | The Patent Leather Kid |",
    ].join("\n");
    const [table] = parseMarkdownTables(md);

    expect(table?.rows[1]).toEqual(["1927/28", "Richard Barthelmess", "Nickie Elkins", "The Noose", ""]);
    // Actor spans too when one actor is nominated for two films.
    expect(table?.rows[2]).toEqual([
      "1927/28",
      "Richard Barthelmess",
      "Patent Leather Kid",
      "The Patent Leather Kid",
      "",
    ]);
  });

  it("finds every table in a document, not just the first", () => {
    const md = [
      "| Year | Actor |",
      "| --- | --- |",
      "| 1994 | Tom Hanks |",
      "",
      "Some prose in between.",
      "",
      "| Year | Actor |",
      "| --- | --- |",
      "| 2004 | Jamie Foxx |",
    ].join("\n");
    expect(parseMarkdownTables(md)).toHaveLength(2);
  });

  it("ignores pipe lines that are not a table", () => {
    expect(parseMarkdownTables("| not a table |\njust prose\n")).toEqual([]);
  });
});

describe("recordsFromMarkdown", () => {
  it("returns one record per row, mapped onto the requested fields", () => {
    const md = [
      "| Year | Actor | Role(s) | Film | Ref. |",
      "| --- | --- | --- | --- | --- |",
      "| 1994 | [Tom Hanks](https://en.wikipedia.org/wiki/Tom_Hanks) | Forrest | _Forrest Gump_ | [\\[1\\]](https://x.test) |",
      "| 1995 | [Nicolas Cage](https://en.wikipedia.org/wiki/Nicolas_Cage) | Ben | _Leaving Las Vegas_ | [\\[2\\]](https://x.test) |",
    ].join("\n");

    expect(recordsFromMarkdown(md, winnerFields)).toEqual([
      { year: "1994", actor: "Tom Hanks", film: "Forrest Gump" },
      { year: "1995", actor: "Nicolas Cage", film: "Leaving Las Vegas" },
    ]);
  });

  it("concatenates tables that share a header signature", () => {
    // Wikipedia splits one logical list into a table per decade. Treating them as
    // separate tables is the difference between 40 rows and 487.
    const decade = (year: number, actor: string) =>
      ["| Year | Actor | Film |", "| --- | --- | --- |", `| ${year} | ${actor} | A Film |`].join("\n");
    const md = [decade(1994, "Tom Hanks"), "", decade(2004, "Jamie Foxx"), "", decade(2014, "Eddie Redmayne")].join("\n");

    const records = recordsFromMarkdown(md, winnerFields);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.actor)).toEqual(["Tom Hanks", "Jamie Foxx", "Eddie Redmayne"]);
  });

  it("prefers the table that actually answers the schema", () => {
    const md = [
      "| Awarded for | Best Performance |",
      "| --- | --- |",
      "| Country | United States |",
      "| Website | oscars.org |",
      "",
      "| Year | Actor | Film |",
      "| --- | --- | --- |",
      "| 1994 | Tom Hanks | Forrest Gump |",
      "| 1995 | Nicolas Cage | Leaving Las Vegas |",
    ].join("\n");

    const records = recordsFromMarkdown(md, winnerFields);
    expect(records).toHaveLength(2);
    expect(records[0]?.actor).toBe("Tom Hanks");
  });

  it("coerces currency and number columns to numbers", () => {
    const fields: FieldSpec[] = [
      { key: "programme", label: "Programme", type: "string" },
      { key: "fee", label: "Tuition fee", type: "currency", unit: "AED" },
    ];
    const md = [
      "| Programme | Tuition fee |",
      "| --- | --- |",
      "| MSc Computing | AED 92,000 |",
      "| MBA | AED 120,500 |",
    ].join("\n");

    expect(recordsFromMarkdown(md, fields)).toEqual([
      { programme: "MSc Computing", fee: 92_000 },
      { programme: "MBA", fee: 120_500 },
    ]);
  });

  it("reads url fields from the link target, not the visible text", () => {
    const fields: FieldSpec[] = [
      { key: "name", label: "Name", type: "string" },
      { key: "link", label: "Link", type: "url" },
    ];
    const md = [
      "| Name | Link |",
      "| --- | --- |",
      "| Example | [the site](https://example.com/page) |",
    ].join("\n");

    expect(recordsFromMarkdown(md, fields)[0]?.link).toBe("https://example.com/page");
  });

  it("returns nothing when no table answers enough of the schema", () => {
    // An infobox matching one of three fields must not be reshaped into rows.
    const md = ["| Website | oscars.org |", "| --- | --- |", "| Country | United States |"].join("\n");
    expect(recordsFromMarkdown(md, winnerFields)).toEqual([]);
  });

  it("returns nothing for a page with no tables at all", () => {
    expect(recordsFromMarkdown("# A prose page\n\nNo tables here.", winnerFields)).toEqual([]);
  });

  it("drops rows that carry no values", () => {
    const md = ["| Year | Actor | Film |", "| --- | --- | --- |", "|  |  |  |", "| 1994 | Tom Hanks | Forrest Gump |"].join("\n");
    expect(recordsFromMarkdown(md, winnerFields)).toHaveLength(1);
  });
});
