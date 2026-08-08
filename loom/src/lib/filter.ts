import type { DataRecord, FieldSpec, Filter } from "../contract/index.js";

type SortSpec = { field: string; dir: "asc" | "desc" };
type ColumnFilterValue = { id: string; value: unknown };

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

export function columnFiltersToFilters(columnFilters: ColumnFilterValue[], fields: FieldSpec[]): Filter[] {
  const numericFields = new Set(fields.filter((field) => field.type === "number" || field.type === "currency").map((field) => field.key));
  const filters: Filter[] = [];
  for (const filter of columnFilters) {
    if (numericFields.has(filter.id)) {
      const range = filter.value as { min?: unknown; max?: unknown } | undefined;
      const min = parseFilterNumber(range?.min);
      const max = parseFilterNumber(range?.max);
      if (min !== null) filters.push({ field: filter.id, op: "gte", value: min });
      if (max !== null) filters.push({ field: filter.id, op: "lte", value: max });
      continue;
    }
    const value = String(filter.value ?? "").trim();
    if (value) filters.push({ field: filter.id, op: "contains", value });
  }
  return filters;
}

export function selectRows(
  records: DataRecord[],
  filters: Filter[] = [],
  sort?: SortSpec,
  fields: FieldSpec[] = [],
): DataRecord[] {
  const rows = applyFilters(records, filters);
  if (!sort) return rows;
  const field = fields.find((item) => item.key === sort.field);
  const numeric = field?.type === "number" || field?.type === "currency";
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = a.row[sort.field];
      const bv = b.row[sort.field];
      const aMissing = av === null || av === undefined;
      const bMissing = bv === null || bv === undefined;
      if (aMissing || bMissing) return aMissing === bMissing ? a.index - b.index : aMissing ? 1 : -1;
      let compared: number;
      if (numeric) {
        const an = toNumber(av);
        const bn = toNumber(bv);
        compared = an !== null && bn !== null ? an - bn : String(av).localeCompare(String(bv));
      } else {
        compared = String(av).localeCompare(String(bv));
      }
      return (sort.dir === "desc" ? -compared : compared) || a.index - b.index;
    })
    .map(({ row }) => row);
}

function parseFilterNumber(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
