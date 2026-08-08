import type { DataRecord, Filter } from "../contract/index.js";

/** Shared by the table, the chart and `get_ui_state` so all three agree on row counts. */
export function applyFilters(records: DataRecord[], filters: Filter[] = []): DataRecord[] {
  if (!filters.length) return records;
  return records.filter((row) => filters.every((f) => matches(row, f)));
}

function matches(row: DataRecord, f: Filter): boolean {
  const raw = row[f.field];
  if (raw === null || raw === undefined) return false;

  if (f.op === "contains") {
    return String(raw).toLowerCase().includes(String(f.value).toLowerCase());
  }

  const a = toNumber(raw);
  const b = toNumber(f.value);
  const numeric = a !== null && b !== null;

  switch (f.op) {
    case "eq":
      return numeric ? a === b : sameText(raw, f.value);
    case "neq":
      return numeric ? a !== b : !sameText(raw, f.value);
    case "lt":
      return numeric && a < b;
    case "lte":
      return numeric && a <= b;
    case "gt":
      return numeric && a > b;
    case "gte":
      return numeric && a >= b;
  }
}

/**
 * Strip everything but digits and parse — or give up.
 *
 * The give-up half matters more than the parse. `Number("")` is 0, not NaN, so
 * stripping the letters out of "Drift" and parsing left every text cell equal to
 * every other: `product eq Drift` matched all 120 rows instead of 24. Any cell with
 * no digits in it is simply not a number.
 */
function toNumber(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Text equality is case- and whitespace-insensitive; nobody dictates exact casing. */
function sameText(raw: string | number, value: string | number): boolean {
  return String(raw).trim().toLowerCase() === String(value).trim().toLowerCase();
}

export function formatValue(value: string | number | null, type?: string, unit?: string): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (type === "currency") {
      return `${unit ?? ""} ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`.trim();
    }
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(value);
}
