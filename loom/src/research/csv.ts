import type { DataRecord, FieldSpec, FieldType } from "../contract/index.js";

/**
 * CSV → dataset columns and rows.
 *
 * Column types are inferred rather than declared, because the point of loading a CSV
 * is that nobody typed a schema for it. Getting this right matters more than it
 * looks: a price column inferred as text cannot be charted, sorted or filtered, so
 * "only the ones under fifty" silently fails later.
 */

/** Handles quoted fields, escaped quotes and embedded newlines. */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const header = rows.shift() ?? [];
  return { header: header.map((h) => h.trim()), rows: rows.filter((r) => r.some((c) => c !== "")) };
}

const CURRENCY = /^[\s$£€₹]*-?[\d,]+(\.\d+)?\s*(usd|aed|eur|gbp)?$/i;
const CURRENCY_MARK = /[$£€₹]|usd|aed|eur|gbp/i;
const DATE = /^\d{4}-\d{2}(-\d{2})?$/;

export function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function inferType(key: string, samples: string[]): { type: FieldType; unit?: string } {
  // Trim first, same as the actual record-building pass below does to `raw` before
  // it ever reaches toNumber/DATE/URL. Inference used to test untrimmed text while
  // parsing tested trimmed text, so a column with incidental padding (a common
  // artifact of spreadsheet exports) would fail DATE's and URL's anchored regexes
  // here — silently falling back to "string" — even though every value parses fine
  // once trimmed. A numeric/date/url column inferred as text cannot be charted,
  // sorted or filtered, and nothing surfaces the mistake.
  const values = samples.map((s) => s.trim()).filter((s) => s !== "");
  if (!values.length) return { type: "string" };

  if (values.every((v) => /^https?:\/\//i.test(v))) return { type: "url" };
  if (values.every((v) => DATE.test(v))) return { type: "date" };

  const numericShare = values.filter((v) => CURRENCY.test(v) && toNumber(v) !== null).length / values.length;
  if (numericShare < 0.9) return { type: "string" };

  // A money column is either marked in the values ("$12.40") or named like one.
  const markedInValues = values.some((v) => CURRENCY_MARK.test(v));
  const namedLikeMoney = /(price|cost|revenue|salary|amount|fee|spend|usd|aed|eur|gbp|_per_m)/i.test(key);
  if (markedInValues || namedLikeMoney) {
    const found = values.find((v) => CURRENCY_MARK.test(v))?.match(CURRENCY_MARK)?.[0];
    const unit = found ? (found.startsWith("$") ? "$" : found.toUpperCase()) : "$";
    return { type: "currency", unit };
  }

  return { type: "number" };
}

function labelFor(key: string): string {
  const cleaned = key.replace(/_/g, " ").replace(/\b(usd|aed|eur|gbp|pct|k|ms)\b/gi, (m) => m.toUpperCase());
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export interface ParsedTable {
  fields: FieldSpec[];
  records: DataRecord[];
}

/** Parse CSV text into the dataset shape the canvas renders. */
export function csvToTable(text: string, sourceId: string): ParsedTable {
  const { header, rows } = parseCsv(text);
  if (!header.length) return { fields: [], records: [] };

  const sample = rows.slice(0, 40);
  const fields: FieldSpec[] = header.map((key, i) => {
    const { type, unit } = inferType(
      key,
      sample.map((r) => r[i] ?? ""),
    );
    return { key, label: labelFor(key), type, ...(unit ? { unit } : {}) };
  });

  const records: DataRecord[] = rows.map((row) => {
    const record: DataRecord = { _source: sourceId };
    fields.forEach((field, i) => {
      const raw = (row[i] ?? "").trim();
      if (raw === "") {
        record[field.key] = null;
      } else if (field.type === "number" || field.type === "currency") {
        record[field.key] = toNumber(raw);
      } else {
        record[field.key] = raw;
      }
    });
    return record;
  });

  return { fields, records };
}
