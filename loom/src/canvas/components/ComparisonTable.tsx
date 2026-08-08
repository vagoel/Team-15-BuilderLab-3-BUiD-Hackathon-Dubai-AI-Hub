import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import {
  tableFeatures,
  useTable,
  createColumnHelper,
  rowSortingFeature,
  createSortedRowModel,
  columnFilteringFeature,
  createFilteredRowModel,
  columnSizingFeature,
  columnResizingFeature,
  functionalUpdate,
} from "@tanstack/react-table";
import type { SortingState, ColumnFiltersState, ColumnDef, SortFn, FilterFn } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { UiComponentSpec, Filter } from "../../contract/ui.js";
import type { DataRecord, Dataset } from "../../contract/dataset.js";
import { applyFilters, columnFiltersToFilters, formatValue } from "../../lib/filter.js";
import { useLoom } from "../../store.js";

/**
 * Column metadata we attach ourselves. TanStack types `meta` as an empty interface by
 * design and expects consumers to augment it; without this, `column.columnDef.meta.numeric`
 * does not type-check even though it is set right here in this file.
 */
declare module "@tanstack/react-table" {
  interface ColumnMeta<TFeatures, TData, TValue> {
    numeric?: boolean;
    type?: string;
  }
}

type ComparisonTableSpec = Extract<UiComponentSpec, { type: "comparison_table" }>;

/** Cell values are normalized to `undefined` (never `null`) so `sortUndefined: "last"` can own null placement. */
type CellValue = string | number | undefined;
type NumberRange = { min?: number; max?: number };

const SCROLL_MAX_HEIGHT = 420;
const ROW_HEIGHT = 34;
const FILTER_DEBOUNCE_MS = 150;

/** Stable identity so `spec.highlights` being absent never invalidates the highlight memo below. */
const EMPTY_HIGHLIGHTS: Filter[] = [];

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  columnFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  columnSizingFeature,
  columnResizingFeature,
});

const helper = createColumnHelper<typeof features, DataRecord>();

function toCellValue(v: string | number | null | undefined): CellValue {
  return v === null || v === undefined ? undefined : v;
}

const numericSortFn: SortFn<typeof features, DataRecord> = (rowA, rowB, columnId) => {
  const av = rowA.getValue<CellValue>(columnId);
  const bv = rowB.getValue<CellValue>(columnId);
  const an = typeof av === "number" ? av : Number(av);
  const bn = typeof bv === "number" ? bv : Number(bv);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(av ?? "").localeCompare(String(bv ?? ""));
};

const textSortFn: SortFn<typeof features, DataRecord> = (rowA, rowB, columnId) => {
  const av = rowA.getValue<CellValue>(columnId);
  const bv = rowB.getValue<CellValue>(columnId);
  return String(av ?? "").localeCompare(String(bv ?? ""));
};

const textIncludesFilterFn: FilterFn<typeof features, DataRecord> = (row, columnId, filterValue) => {
  const raw = row.getValue<CellValue>(columnId);
  const needle = String(filterValue ?? "").trim().toLowerCase();
  if (!needle) return true;
  if (raw === undefined) return false;
  return String(raw).toLowerCase().includes(needle);
};
textIncludesFilterFn.autoRemove = (value) => value === undefined || value === "";

const numberRangeFilterFn: FilterFn<typeof features, DataRecord> = (row, columnId, filterValue) => {
  const range = (filterValue ?? {}) as NumberRange;
  if (range.min === undefined && range.max === undefined) return true;
  const raw = row.getValue<CellValue>(columnId);
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) return false;
  if (range.min !== undefined && num < range.min) return false;
  if (range.max !== undefined && num > range.max) return false;
  return true;
};
numberRangeFilterFn.autoRemove = (value) => {
  const range = value as NumberRange | undefined;
  return !range || (range.min === undefined && range.max === undefined);
};

export function ComparisonTable({ spec, dataset }: { spec: ComparisonTableSpec; dataset: Dataset | undefined }) {
  if (!dataset) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>No data yet.</p>;
  }
  if (!dataset.records.length) {
    return <p style={{ color: "var(--dim)", fontSize: 13 }}>No rows in this dataset.</p>;
  }

  return <ComparisonTableInner spec={spec} dataset={dataset} />;
}

/**
 * Split out so hooks are never called conditionally — the guard clauses above run in the
 * outer component, this one always mounts with a non-empty dataset.
 */
function ComparisonTableInner({ spec, dataset }: { spec: ComparisonTableSpec; dataset: Dataset }) {
  const fieldByKey = useMemo(() => new Map(dataset.fields.map((f) => [f.key, f] as const)), [dataset.fields]);
  const columnKeys = spec.columns.length ? spec.columns : dataset.fields.map((f) => f.key);

  // Layer 1: spec.filters, set by the agent's voice tool. Shared with `get_ui_state` via
  // `applyFilters` so the agent and the screen never disagree on row counts.
  const baseRows = useMemo(() => applyFilters(dataset.records, spec.filters), [dataset.records, spec.filters]);

  // Highlights remove nothing — they mark rows within whatever `filters` already let
  // through. `applyFilters` ANDs its filter list, so "matches ANY highlight" needs one
  // call per highlight per row rather than one call over the whole list.
  const highlights = spec.highlights ?? EMPTY_HIGHLIGHTS;
  const hasHighlights = highlights.length > 0;

  // Computed once per (baseRows, highlights) pair, not per rendered row: the virtualizer
  // re-renders on every scroll frame but neither dependency changes then, so this memo
  // holds and each row only pays a O(1) Set lookup during scroll instead of re-running
  // applyFilters. Keyed by row identity (not index) so highlighting survives sorting.
  const highlightedRows = useMemo(() => {
    if (!hasHighlights) return null;
    const set = new Set<DataRecord>();
    for (const row of baseRows) {
      if (highlights.some((h) => applyFilters([row], [h]).length === 1)) set.add(row);
    }
    return set;
  }, [baseRows, highlights, hasHighlights]);
  const highlightedCount = highlightedRows?.size ?? 0;

  // Layer 2: TanStack's own column filters, typed into the header row. Purely local UI state.
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const tableIdentity = `${dataset.id}:${columnKeys.join("\u001f")}`;
  const previousIdentity = useRef(tableIdentity);
  useEffect(() => {
    if (previousIdentity.current === tableIdentity) return;
    previousIdentity.current = tableIdentity;
    setColumnFilters([]);
    useLoom.getState().setTableViewFilters(spec.id, dataset.id, []);
  }, [dataset.id, spec.id, tableIdentity]);
  const handleColumnFiltersChange = useCallback(
    (updater: ColumnFiltersState | ((old: ColumnFiltersState) => ColumnFiltersState)) => {
      setColumnFilters((old) => {
        const next = functionalUpdate(updater, old);
        useLoom.getState().setTableViewFilters(spec.id, dataset.id, columnFiltersToFilters(next, dataset.fields));
        return next;
      });
    },
    [dataset.fields, dataset.id, spec.id],
  );

  // Sorting is NOT local state — spec.sort is the source of truth so a header click and the
  // agent's sort_table tool land in the same place. Memoized so the sorted row model does not
  // invalidate on every unrelated re-render (state identity, not just value, drives that cache).
  const sorting: SortingState = useMemo(
    () => (spec.sort ? [{ id: spec.sort.field, desc: spec.sort.dir === "desc" }] : []),
    [spec.sort?.field, spec.sort?.dir],
  );
  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const next = functionalUpdate(updater, sorting);
      const first = next[0];
      useLoom.getState().patchComponent(spec.id, { sort: first ? { field: first.id, dir: first.desc ? "desc" : "asc" } : undefined });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec.id, spec.sort?.field, spec.sort?.dir],
  );

  // Let the column type infer. Annotating it as ColumnDef<..., CellValue>[] fails:
  // TanStack's ColumnDef is invariant in its value parameter, so a CellValue-typed
  // array is not assignable to the unknown-typed array useTable expects.
  const columns = useMemo(() => {
    return columnKeys.map((key) => {
      const field = fieldByKey.get(key);
      const numeric = field?.type === "number" || field?.type === "currency";
      return helper.accessor((row) => toCellValue(row[key]), {
        id: key,
        header: field?.label ?? key,
        size: numeric ? 120 : 170,
        minSize: 64,
        sortUndefined: "last",
        sortFn: numeric ? numericSortFn : textSortFn,
        filterFn: numeric ? numberRangeFilterFn : textIncludesFilterFn,
        cell: (info) => formatValue(info.getValue() ?? null, field?.type, field?.unit),
        meta: { numeric, type: field?.type },
      });
    });
  }, [columnKeys, fieldByKey]);

  const table = useTable({
    features,
    data: baseRows,
    // TanStack v9's ColumnDef is invariant in its value type parameter, so a column
    // list typed by what its accessors actually return cannot widen to the
    // unknown-valued list useTable expects. The runtime shape is identical — only the
    // generic disagrees — so this cast is the whole of the compromise.
    columns: columns as unknown as ColumnDef<typeof features, DataRecord, unknown>[],
    state: { sorting, columnFilters },
    onSortingChange: handleSortingChange,
    onColumnFiltersChange: handleColumnFiltersChange,
    enableMultiSort: false,
    // Without this, numeric columns auto-default to a descending first click (TanStack's
    // built-in heuristic) while text columns default to ascending — an inconsistent cycle.
    // Force every column through the same neutral -> asc -> desc -> neutral order.
    sortDescFirst: false,
    columnResizeMode: "onChange",
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => tableRows[index]?.id ?? index,
  });

  const virtualRows = rowVirtualizer.getVirtualItems();
  const firstVirtual = virtualRows[0];
  const lastVirtual = virtualRows[virtualRows.length - 1];
  const paddingTop = firstVirtual ? firstVirtual.start : 0;
  const paddingBottom = lastVirtual ? rowVirtualizer.getTotalSize() - lastVirtual.end : 0;

  const totalRows = dataset.records.length;
  const voiceFiltered = baseRows.length;
  const finalRows = tableRows.length;
  const hasVoiceFilters = spec.filters.length > 0;
  const hasLocalFilters = columnFilters.length > 0;

  // Bumped on "clear" so every FilterCell remounts and drops its own draft text/range —
  // otherwise the inputs would keep showing stale text after the committed filters reset.
  const [filterGeneration, setFilterGeneration] = useState(0);
  const clearLocalFilters = () => {
    handleColumnFiltersChange([]);
    setFilterGeneration((g) => g + 1);
  };

  return (
    <div>
      <div
        ref={scrollRef}
        className="scroll"
        style={{ maxHeight: SCROLL_MAX_HEIGHT, overflow: "auto", position: "relative", border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}
      >
        <table
          style={{
            width: table.getTotalSize(),
            minWidth: "100%",
            tableLayout: "fixed",
            borderCollapse: "separate",
            borderSpacing: 0,
            fontSize: "var(--text-sm)",
          }}
        >
          <colgroup>
            {table.getFlatHeaders().map((h) => (
              <col key={h.id} style={{ width: h.getSize() }} />
            ))}
          </colgroup>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const numeric = header.column.columnDef.meta?.numeric ?? false;
                  const sortDir = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();
                  // aria-sort tells assistive tech the current sort of this column; only
                  // meaningful on sortable columns, so it stays undefined otherwise.
                  const ariaSort = !canSort
                    ? undefined
                    : sortDir === "asc"
                      ? "ascending"
                      : sortDir === "desc"
                        ? "descending"
                        : "none";
                  const label = header.isPlaceholder ? null : <table.FlexRender header={header} />;
                  return (
                    <th key={header.id} scope="col" aria-sort={ariaSort} style={headerCellStyle}>
                      {canSort ? (
                        // A real button so the sort is keyboard-operable (Enter/Space) and
                        // gets the global focus-visible ring; a click-only <th> was mouse-only.
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          style={{ ...headerButtonStyle, flexDirection: numeric ? "row-reverse" : "row" }}
                        >
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", textAlign: numeric ? "right" : "left" }}>
                            {label}
                          </span>
                          <span aria-hidden style={{ flex: "none", color: sortDir ? "var(--accent)" : "var(--dim)", fontSize: 9 }}>
                            {sortDir === "asc" ? "▲" : sortDir === "desc" ? "▼" : "⋮"}
                          </span>
                        </button>
                      ) : (
                        <div style={{ ...headerButtonStyle, cursor: "default", textAlign: numeric ? "right" : "left" }}>{label}</div>
                      )}
                      {header.column.getCanResize() && (
                        <div
                          aria-hidden
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            position: "absolute",
                            right: 0,
                            top: 0,
                            height: "100%",
                            width: 6,
                            cursor: "col-resize",
                            touchAction: "none",
                            background: header.column.getIsResizing() ? "var(--accent)" : "transparent",
                          }}
                        />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
            <tr>
              {table.getFlatHeaders().map((header) => (
                <FilterCell key={`${header.id}:${filterGeneration}`} header={header} />
              ))}
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr aria-hidden style={{ height: paddingTop }}>
                <td colSpan={columns.length} style={{ padding: 0, border: "none" }} />
              </tr>
            )}
            {finalRows === 0 && (
              <tr>
                <td colSpan={columns.length} style={{ padding: "18px 10px", color: "var(--dim)", fontSize: 13, textAlign: "center" }}>
                  {voiceFiltered === 0 ? "No rows match the current filter." : "No rows match the column filters."}
                </td>
              </tr>
            )}
            {virtualRows.map((vRow) => {
              const row = tableRows[vRow.index];
              if (!row) return null;
              const isHighlighted = highlightedRows?.has(row.original) ?? false;
              // Editorial data-desk: hairline row rules carry the scan, not zebra fills.
              const zebra = "transparent";
              return (
                <tr
                  key={row.id}
                  data-index={vRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    // Layer the tint over the zebra color rather than replace it (two
                    // background layers: a solid-stop gradient of --accent-soft on top,
                    // the existing zebra/transparent color underneath) so striping still
                    // reads through a highlighted row. `.loom-table-row:hover` still wins
                    // on top of this via its `!important`.
                    background: isHighlighted ? `linear-gradient(var(--accent-soft), var(--accent-soft)), ${zebra}` : zebra,
                  }}
                  className="loom-table-row"
                >
                  {row.getAllCells().map((cell, cellIndex) => {
                    const numeric = cell.column.columnDef.meta?.numeric ?? false;
                    return (
                      <td
                        key={cell.id}
                        style={{
                          textAlign: numeric ? "right" : "left",
                          padding: "7px 10px",
                          borderBottom: "1px solid var(--line-soft)",
                          color: "var(--ink)",
                          fontFamily: numeric ? "var(--font-mono)" : undefined,
                          fontVariantNumeric: numeric ? "tabular-nums" : undefined,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          // Accent border on the row's leading edge only, as an inset
                          // box-shadow so it never perturbs the fixed column widths the
                          // way a real `border-left` would.
                          boxShadow: isHighlighted && cellIndex === 0 ? "inset 3px 0 0 var(--accent)" : undefined,
                        }}
                      >
                        <table.FlexRender cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr aria-hidden style={{ height: paddingBottom }}>
                <td colSpan={columns.length} style={{ padding: 0, border: "none" }} />
              </tr>
            )}
          </tbody>
        </table>
        <style>{`.loom-table-row:hover { background: var(--accent-soft) !important; }`}</style>
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--dim)", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
        <span>
          showing <strong style={{ color: "var(--mute)" }}>{finalRows}</strong> of {totalRows} rows
        </span>
        {hasVoiceFilters && (
          <span>
            voice filters: <strong style={{ color: "var(--mute)" }}>{spec.filters.length}</strong> active ({voiceFiltered} matched)
          </span>
        )}
        {hasHighlights && (
          <span>
            highlights: <strong style={{ color: "var(--mute)" }}>{highlights.length}</strong> active,{" "}
            <strong style={{ color: "var(--accent)" }}>{highlightedCount}</strong> highlighted
          </span>
        )}
        {hasLocalFilters && (
          <span>
            column filters narrowing further ({columnFilters.length})
            <button
              onClick={clearLocalFilters}
              style={{
                marginLeft: 6,
                fontSize: 11,
                color: "var(--accent)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                textDecoration: "underline",
              }}
            >
              clear
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** Debounced per-column filter input rendered inside the header row. */
function FilterCell({
  header,
}: {
  header: ReturnType<ReturnType<typeof useTable<typeof features, DataRecord>>["getFlatHeaders"]>[number];
}) {
  const numeric = header.column.columnDef.meta?.numeric ?? false;
  const committed = header.column.getFilterValue();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [text, setText] = useState(() => (typeof committed === "string" ? committed : ""));
  const [range, setRange] = useState<{ min: string; max: string }>(() => {
    const r = (committed as NumberRange | undefined) ?? {};
    return { min: r.min === undefined ? "" : String(r.min), max: r.max === undefined ? "" : String(r.max) };
  });

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const debounce = (fn: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, FILTER_DEBOUNCE_MS);
  };

  if (numeric) {
    return (
      <th style={filterCellStyle}>
        <div style={{ display: "flex", gap: 4 }}>
          <input
            type="number"
            placeholder="min"
            value={range.min}
            onChange={(e) => {
              const next = { ...range, min: e.target.value };
              setRange(next);
              debounce(() => header.column.setFilterValue(rangeFromDraft(next)));
            }}
            style={numberInputStyle}
          />
          <input
            type="number"
            placeholder="max"
            value={range.max}
            onChange={(e) => {
              const next = { ...range, max: e.target.value };
              setRange(next);
              debounce(() => header.column.setFilterValue(rangeFromDraft(next)));
            }}
            style={numberInputStyle}
          />
        </div>
      </th>
    );
  }

  return (
    <th style={filterCellStyle}>
      <input
        type="text"
        placeholder="filter…"
        value={text}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          debounce(() => header.column.setFilterValue(value || undefined));
        }}
        style={textInputStyle}
      />
    </th>
  );
}

function rangeFromDraft(draft: { min: string; max: string }): NumberRange | undefined {
  const min = draft.min.trim() === "" ? undefined : Number(draft.min);
  const max = draft.max.trim() === "" ? undefined : Number(draft.max);
  const validMin = min !== undefined && Number.isFinite(min) ? min : undefined;
  const validMax = max !== undefined && Number.isFinite(max) ? max : undefined;
  return validMin === undefined && validMax === undefined ? undefined : { min: validMin, max: validMax };
}

const headerCellStyle: React.CSSProperties = {
  padding: 0,
  borderBottom: "1px solid var(--line)",
  background: "var(--panel-2)",
  position: "sticky",
  top: 0,
  zIndex: "var(--z-sticky)" as unknown as number,
  whiteSpace: "nowrap",
  overflow: "hidden",
};

const headerButtonStyle: React.CSSProperties = {
  width: "100%",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "8px 10px",
  color: "var(--dim)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  fontWeight: 700,
  userSelect: "none",
};

const filterCellStyle: React.CSSProperties = {
  padding: "5px 8px",
  borderBottom: "1px solid var(--line)",
  background: "var(--panel-2)",
  position: "sticky",
  top: ROW_HEIGHT,
  zIndex: "var(--z-sticky)" as unknown as number,
};

const textInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-sm)",
  color: "var(--ink)",
  fontSize: "var(--text-xs)",
  padding: "4px 6px",
};

const numberInputStyle: React.CSSProperties = {
  width: "50%",
  boxSizing: "border-box",
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-sm)",
  color: "var(--ink)",
  fontSize: "var(--text-xs)",
  padding: "4px 6px",
};
