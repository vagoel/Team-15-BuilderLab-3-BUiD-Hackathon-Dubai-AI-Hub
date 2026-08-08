import type { DataRecord, FieldSpec, FieldType } from "../contract/dataset.js";

/**
 * Records straight out of raw scraped markdown, by parsing its tables.
 *
 * Why this exists: `/web/extract` is an LLM reading the page, and on a long list
 * page it summarises no matter how emphatically the instructions say otherwise.
 * The Wikipedia "Academy Award for Best Actor" page returned exactly one record
 * from extract; `/web/scrape/markdown` returns the same page as 307k characters
 * of markdown holding 487 winner rows in eleven decade-by-decade tables. When the
 * data is already tabular, parsing the raw markdown is both exhaustive and about
 * thirty times faster (~1s vs the ~22s extract budget).
 *
 * So extract was removed outright. This is now the ONLY way a report gains rows:
 * a table the page actually printed. A prose page yields no rows at all — it
 * contributes sources and cited findings instead. See pipeline.ts.
 */

/** One GFM pipe table. Cells are raw markdown — callers clean per field type. */
export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

/** A `| --- | :--- | ---: |` alignment row, which is what makes a table a table. */
const SEPARATOR_ROW = /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/;

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Strip markdown link syntax, keeping the visible text.
 *
 * The inner alternation tolerates one level of nested parentheses so that
 * `[The Way of All Flesh](https://…/The_Way_of_All_Flesh_(1927_film) 'title')`
 * — extremely common on Wikipedia — does not terminate at the paren inside the
 * URL and leak `'title')` into the cell text.
 */
const MARKDOWN_LINK = /\[((?:[^\]\\]|\\.)*)\]\((?:[^()]|\([^()]*\))*\)/g;

/** The body of a citation marker: `7`, `A`, `note 1`, `citation needed`. */
const CITATION_BODY = String.raw`\s*(?:\d+|[A-Za-z]|note\s*\d+|citation needed)\s*`;

/**
 * A whole citation *link* — `[\[7\]](https://…#cite_note-7)`.
 *
 * Handled ahead of the general link rule because the scraper escapes the inner
 * brackets, and `[...]` link text containing an escaped `]` is ambiguous enough
 * that the general rule mis-anchors and leaves `[](https://…)` behind.
 */
const CITATION_LINK = new RegExp(String.raw`\[\s*\\?\[${CITATION_BODY}\\?\]\s*\]\([^)]*\)`, "gi");

/** A bare citation marker with no link around it: `[7]`, `[note 1]`. */
const CITATION_MARKER = new RegExp(String.raw`\[${CITATION_BODY}\]`, "gi");

/** Clean one raw cell down to readable text. */
export function cleanCell(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(CITATION_LINK, "")
    .replace(MARKDOWN_LINK, "$1")
    .replace(/\\([[\]()*_])/g, "$1")
    .replace(CITATION_MARKER, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    // Wikipedia marks winners with ‡ and other outcomes with † / ✝.
    .replace(/[‡†✝]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The kind of value a column holds, used to realign rowspan-flattened rows.
 *
 * Deliberately coarse: only shapes distinctive enough that seeing the wrong one
 * is strong evidence a candidate alignment is wrong.
 */
type CellShape = "year" | "citation" | "empty" | "text";

function shapeOf(raw: string): CellShape {
  const text = cleanCell(raw);
  // A Ref column cleans down to nothing but still carries a link in the source.
  if (!text) return /\]\(/.test(raw) ? "citation" : "empty";
  if (/^\d{4}\b/.test(text)) return "year";
  return "text";
}

/** Whether a cell of `actual` shape can plausibly sit in a column that the
 * anchor row showed holding `expected`. Only the distinctive shapes constrain. */
function shapesConflict(expected: CellShape, actual: CellShape): boolean {
  switch (expected) {
    case "year":
      return actual !== "year";
    // A reference column holds citations or nothing. Real prose landing in it is
    // the strongest available signal that a candidate alignment is shifted right.
    case "citation":
      return actual !== "citation" && actual !== "empty";
    case "text":
      return actual === "year" || actual === "citation";
    case "empty":
    default:
      return false;
  }
}

/**
 * Realign a row that carries fewer cells than the table has columns.
 *
 * A `rowspan` in the source HTML disappears when the table is flattened to
 * markdown — the spanned cell is printed once and the rows beneath it simply
 * omit it. Wikipedia's award tables span *both* ends of the row at once:
 *
 *   | Year          | Actor           | Role(s)  | Film                 | Ref. |
 *   | 1927/28 (1st) | Emil Jannings   | Sergius  | The Last Command     | [7]  |
 *   |                 Richard Barth…  | Nickie   | The Noose            |        <- 3 cells
 *   |                                  Patent…   | The Patent Leather…  |        <- 2 cells
 *
 * Year and Ref both span the whole year-group, so a nominee row is missing a
 * leading column *and* a trailing one. Assuming only leading columns were
 * dropped puts roles in the film column — data that looks real and is not.
 *
 * Since the omitted positions are not recoverable from the markdown alone, try
 * every contiguous placement of the row's cells and keep the one that conflicts
 * least with the shapes the last full-width row established for each column.
 * Ties prefer the later start, because a dropped leading cell is far more common
 * than a dropped trailing one.
 *
 * Columns before the chosen window inherit from `previous` — the row immediately
 * above, reconstructed or not — because that is what a span actually continues
 * from. (Shapes come from the last full-width row instead, since only those rows
 * have certain alignment.) In the example above, "Patent Leather Kid" is a second
 * role for Richard Barthelmess, not for Emil Jannings.
 *
 * A row with more cells than the header is truncated rather than dropped — a
 * trailing stray pipe should not cost a real row.
 */
function alignRow(cells: string[], shapes: CellShape[], previous: string[] | undefined): string[] {
  const headerCount = shapes.length;
  if (cells.length === headerCount) return cells;
  if (cells.length > headerCount) return cells.slice(0, headerCount);
  if (!previous) {
    // Nothing to inherit from yet — left-align and pad.
    return cells.concat(Array(headerCount - cells.length).fill(""));
  }

  let bestStart = 0;
  let bestConflicts = Number.POSITIVE_INFINITY;
  for (let start = 0; start + cells.length <= headerCount; start++) {
    let conflicts = 0;
    for (let i = 0; i < cells.length; i++) {
      if (shapesConflict(shapes[start + i]!, shapeOf(cells[i]!))) conflicts++;
    }
    if (conflicts <= bestConflicts) {
      bestConflicts = conflicts;
      bestStart = start;
    }
  }

  const out: string[] = [];
  for (let i = 0; i < bestStart; i++) out.push(previous[i] ?? "");
  out.push(...cells);
  while (out.length < headerCount) out.push("");
  return out;
}

/** Every GFM pipe table in the document, in order. */
export function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split("\n");
  const tables: MarkdownTable[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (!line || !next) continue;
    if (!line.trim().startsWith("|") || !SEPARATOR_ROW.test(next)) continue;

    const headers = splitCells(line).map(cleanCell);
    const rows: string[][] = [];
    // Shapes come from the last full-width row (certain alignment); inherited
    // values come from the row immediately above (where a span continues from).
    let previous: string[] | undefined;
    let shapes: CellShape[] = Array(headers.length).fill("text");

    let j = i + 2;
    for (; j < lines.length; j++) {
      const rowLine = lines[j];
      if (!rowLine || !rowLine.trim().startsWith("|")) break;
      if (SEPARATOR_ROW.test(rowLine)) continue;
      const cells = splitCells(rowLine);
      if (cells.length === headers.length) shapes = cells.map(shapeOf);
      const aligned = alignRow(cells, shapes, previous);
      rows.push(aligned);
      previous = aligned;
    }

    if (rows.length > 0) tables.push({ headers, rows });
    // Resume scanning after this table; -1 offsets the loop's own increment.
    i = j - 1;
  }

  return tables;
}

// ---------------------------------------------------------------------------
// Header -> field matching
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * How well a column header answers a requested field. Higher wins; 0 means no.
 *
 * Scored rather than boolean because a page often has several plausible columns
 * ("Film" vs "Ref.") and the strongest match should claim the field.
 */
function matchScore(header: string, field: FieldSpec): number {
  const h = normalize(header);
  if (!h) return 0;
  const candidates = [normalize(field.label), normalize(field.key.replace(/_/g, " "))];

  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    if (h === c) best = Math.max(best, 100);
    else if (h.startsWith(c) || c.startsWith(h)) best = Math.max(best, 70);
    else if (h.includes(c) || c.includes(h)) best = Math.max(best, 40);
    else {
      // Token overlap catches "Role(s)" vs "role" and "Tuition fees" vs "fee".
      const ht = new Set(h.split(" "));
      const shared = c.split(" ").filter((t) => t.length > 2 && ht.has(t)).length;
      if (shared > 0) best = Math.max(best, 20 + shared);
    }
  }
  return best;
}

/** Field key -> column index, for the columns this table can actually answer. */
function mapColumns(headers: string[], fields: FieldSpec[]): Map<string, number> {
  const mapping = new Map<string, number>();
  const claimed = new Set<number>();

  // Strongest pairs first, so a single column cannot be claimed by a weak match
  // when a better field wants it.
  const pairs: { field: FieldSpec; index: number; score: number }[] = [];
  for (const field of fields) {
    headers.forEach((header, index) => {
      const score = matchScore(header, field);
      if (score > 0) pairs.push({ field, index, score });
    });
  }
  pairs.sort((a, b) => b.score - a.score);

  for (const pair of pairs) {
    if (mapping.has(pair.field.key) || claimed.has(pair.index)) continue;
    mapping.set(pair.field.key, pair.index);
    claimed.add(pair.index);
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Cell -> typed value
// ---------------------------------------------------------------------------

function parseNumeric(text: string): number | null {
  const m = text.match(/-?[0-9][0-9,]*(?:\.[0-9]+)?/);
  if (!m) return null;
  let num = Number.parseFloat(m[0].replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  const suffix = text.slice(m.index! + m[0].length, m.index! + m[0].length + 1);
  if (/k/i.test(suffix)) num *= 1_000;
  if (/m/i.test(suffix)) num *= 1_000_000;
  return num;
}

function coerce(raw: string, field: FieldSpec): string | number | null {
  // URLs live in the link *target*, which cleaning throws away — read the raw cell.
  if (field.type === "url") {
    const inLink = raw.match(/\]\((https?:\/\/[^\s)]+)/);
    if (inLink?.[1]) return inLink[1];
    const bare = raw.match(/https?:\/\/[^\s)\]]+/);
    return bare ? bare[0] : null;
  }

  const text = cleanCell(raw);
  if (!text) return null;

  switch (field.type) {
    case "number":
    case "currency":
      return parseNumeric(text);
    case "date":
    case "string":
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Table selection and record building
// ---------------------------------------------------------------------------

/** Tables with identical headers are one logical table split for presentation —
 * Wikipedia breaks its winners list into eleven per-decade tables with the same
 * five columns. Grouping by header signature is what turns 40 rows into 487. */
function signatureOf(table: MarkdownTable): string {
  return table.headers.map(normalize).join("|");
}

/** A table must answer at least this share of the requested fields to be used.
 * Below it we are pattern-matching noise (an infobox, a navigation table) onto a
 * schema it was never describing, and inventing rows is worse than finding none. */
const MIN_FIELD_COVERAGE = 0.5;

function coverageOf(table: MarkdownTable, fields: FieldSpec[]): number {
  return fields.length === 0 ? 0 : mapColumns(table.headers, fields).size / fields.length;
}

/**
 * One DataRecord per table row, across every table that answers the schema.
 *
 * Returns [] when nothing on the page is tabular enough to trust — the caller
 * treats that as "this page needs the extract path" rather than as an error.
 */
export function recordsFromMarkdown(markdown: string, fields: FieldSpec[]): DataRecord[] {
  if (fields.length === 0) return [];

  const tables = parseMarkdownTables(markdown);
  if (tables.length === 0) return [];

  // Group by header signature, then take the group with the best coverage and,
  // as the tiebreak, the most rows.
  const groups = new Map<string, MarkdownTable[]>();
  for (const table of tables) {
    const sig = signatureOf(table);
    const group = groups.get(sig);
    if (group) group.push(table);
    else groups.set(sig, [table]);
  }

  let best: { tables: MarkdownTable[]; coverage: number; rows: number } | undefined;
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const coverage = coverageOf(first, fields);
    if (coverage < MIN_FIELD_COVERAGE) continue;
    const rows = group.reduce((n, t) => n + t.rows.length, 0);
    if (!best || coverage > best.coverage || (coverage === best.coverage && rows > best.rows)) {
      best = { tables: group, coverage, rows };
    }
  }
  if (!best) return [];

  const headers = best.tables[0]!.headers;
  const mapping = mapColumns(headers, fields);

  const records: DataRecord[] = [];
  for (const table of best.tables) {
    for (const row of table.rows) {
      const record: DataRecord = {};
      for (const field of fields) {
        const index = mapping.get(field.key);
        const raw = index === undefined ? undefined : row[index];
        record[field.key] = raw === undefined ? null : coerce(raw, field);
      }
      // An all-null row is a spacer or a section heading rendered as a row, not data.
      if (Object.values(record).some((v) => v !== null)) records.push(record);
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Schema inference
//
// With `/web/extract` gone, nobody hands us a field schema any more — the agent
// picks pages, not columns. So the table's own headers become the schema, and the
// column values decide each field's type. This is the only way rows are ever
// created: a header the page actually printed, over values the page actually held.
// ---------------------------------------------------------------------------

/** Header text -> a snake_case key safe to use as a field key and a React key. */
function toFieldKey(header: string, index: number): string {
  const key = normalize(header).replace(/\s+/g, "_").slice(0, 40);
  return key || `column_${index + 1}`;
}

const CURRENCY_HINT = /[$€£¥₹]|\b(aed|usd|eur|gbp|inr|sar|price|cost|fee|salary|revenue)\b/i;
const DATE_LIKE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]+ \d{1,2},? \d{4})$/;

/**
 * Decide a column's type from what is actually in it.
 *
 * Majority rules rather than first-value-wins: a price column with one "N/A" in it
 * is still a price column, and typing it as a string would cost every chart and
 * every min/max stat that column could have produced.
 */
function inferFieldType(header: string, values: string[]): FieldType {
  const filled = values.filter((v) => v.length > 0);
  if (filled.length === 0) return "string";

  const share = (pred: (v: string) => boolean) => filled.filter(pred).length / filled.length;

  if (share((v) => /^https?:\/\//.test(v)) > 0.5) return "url";
  if (share((v) => DATE_LIKE.test(v)) > 0.5) return "date";

  const numericish = share((v) => /^[$€£¥₹]?\s?-?[0-9][0-9,]*(\.[0-9]+)?\s*[kKmM]?$/.test(v));
  if (numericish > 0.6) {
    return CURRENCY_HINT.test(header) || share((v) => /[$€£¥₹]/.test(v)) > 0.3 ? "currency" : "number";
  }
  return "string";
}

export interface InferredTable {
  fields: FieldSpec[];
  records: DataRecord[];
}

/**
 * Read a page's biggest genuine table as a dataset.
 *
 * Returns `undefined` when the page has no table worth the name — prose pages must
 * produce zero rows, never a plausible-looking row assembled out of nothing. That
 * is the honesty boundary the whole raw pipeline rests on.
 */
export function inferTableFromMarkdown(markdown: string): InferredTable | undefined {
  const tables = parseMarkdownTables(markdown);
  if (tables.length === 0) return undefined;

  // Same grouping rule as recordsFromMarkdown: identical headers are one logical
  // table split for presentation (Wikipedia does this per decade), and the group is
  // the difference between 40 rows and 487.
  const groups = new Map<string, MarkdownTable[]>();
  for (const table of tables) {
    const sig = signatureOf(table);
    const group = groups.get(sig);
    if (group) group.push(table);
    else groups.set(sig, [table]);
  }

  let best: MarkdownTable[] | undefined;
  let bestRows = 0;
  for (const group of groups.values()) {
    const first = group[0];
    if (!first || first.headers.length < 2) continue;
    // A two-column key/value block is an infobox, not a dataset. Require enough
    // rows that the thing is recognisably a list.
    const rows = group.reduce((n, t) => n + t.rows.length, 0);
    if (rows < 2) continue;
    if (rows > bestRows) {
      best = group;
      bestRows = rows;
    }
  }
  if (!best) return undefined;

  const headers = best[0]!.headers;
  const allRows = best.flatMap((t) => t.rows);

  const seen = new Set<string>();
  const fields: FieldSpec[] = headers.map((header, i) => {
    let key = toFieldKey(header, i);
    while (seen.has(key)) key = `${key}_${i}`;
    seen.add(key);
    const column = allRows.map((row) => cleanCell(row[i] ?? ""));
    return { key, label: header || `Column ${i + 1}`, type: inferFieldType(header, column) };
  });

  const records: DataRecord[] = [];
  for (const row of allRows) {
    const record: DataRecord = {};
    fields.forEach((field, i) => {
      record[field.key] = coerce(row[i] ?? "", field);
    });
    if (Object.values(record).some((v) => v !== null)) records.push(record);
  }

  return records.length ? { fields, records } : undefined;
}
