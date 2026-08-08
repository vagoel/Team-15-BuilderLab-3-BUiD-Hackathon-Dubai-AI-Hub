import { Component, useEffect, useRef } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { GridLayout, useContainerWidth } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import type { Dataset } from "../contract/dataset.js";
import type { LayoutKind, UiComponentSpec, UiSpec } from "../contract/ui.js";
import { renderComponent } from "./registry.js";
import { useLoom } from "../store.js";

const EXAMPLE_PROMPTS = [
  "Compare 2-bedroom prices in Dubai Marina and JVC",
  "What are the top AI hardware startups this year",
  "Summarise these three pricing pages",
];

/** The presets the user can switch between; `stack` is internal (tiny dashboards). */
const LAYOUT_PRESETS: Array<{ kind: LayoutKind; label: string }> = [
  { kind: "masonry", label: "Masonry" },
  { kind: "focus", label: "Focus" },
  { kind: "grid", label: "Grid" },
];

export function Canvas() {
  const spec = useLoom((s) => s.spec);
  const datasets = useLoom((s) => s.datasets);
  const focusedId = useLoom((s) => s.focusedId);
  const status = useLoom((s) => s.status);
  const progress = useLoom((s) => s.progress);
  const setLayout = useLoom((s) => s.setLayout);

  if (!spec) {
    return (
      <main className="canvas">
        {status === "researching" ? (
          <div className="empty">
            <div className="spinner" />
            <p>{progress?.label ?? "Researching…"}</p>
            {progress && (
              <p style={{ fontSize: 13 }}>
                {progress.done} / {progress.total}
              </p>
            )}
          </div>
        ) : (
          <div className="empty">
            <h2>Ask me to research something</h2>
            <p>
              Speak or type a question — Loom researches the web and builds a live dashboard of the
              answer, right here.
            </p>
            <div>
              {EXAMPLE_PROMPTS.map((prompt) => (
                <span className="chip" key={prompt}>
                  {prompt}
                </span>
              ))}
            </div>
          </div>
        )}
      </main>
    );
  }

  const { sourceCount, rowCount } = summarize(spec, datasets);

  return (
    <main className="canvas">
      <div className="canvas-head">
        <div>
          <div className="canvas-title">{spec.title ?? "Results"}</div>
          <div className="canvas-sub">
            {sourceCount} source{sourceCount === 1 ? "" : "s"} · {rowCount} row{rowCount === 1 ? "" : "s"}
          </div>
        </div>
        <div className="layout-switch" role="tablist" aria-label="Layout">
          {LAYOUT_PRESETS.map((p) => (
            <button
              key={p.kind}
              role="tab"
              aria-selected={spec.layout === p.kind}
              className={"layout-pill" + (spec.layout === p.kind ? " active" : "")}
              onClick={() => setLayout(p.kind)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {spec.layout === "stack" ? (
        <div className="stack">
          {spec.components.map((c) => (
            <ComponentCard
              key={c.id}
              c={c}
              dataset={datasetFor(c, datasets)}
              focused={focusedId === c.id}
              weightClass={cardWeightClass(c.type) || undefined}
            />
          ))}
        </div>
      ) : (
        <DashboardGrid spec={spec} datasets={datasets} focusedId={focusedId} />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// react-grid-layout dashboard
// ---------------------------------------------------------------------------

/**
 * Grid geometry. A small row unit means heights land close to what the user
 * dragged; with rowHeight 8 and a 16px margin one grid row costs 24 rendered px
 * (h rows = 8h + 16(h-1) px), so `pxToRows`/`rowsToPx` below are exact inverses.
 */
const COLS = 12;
const ROW_HEIGHT = 8;
const MARGIN = 16;

function pxToRows(px: number): number {
  return Math.max(3, Math.round((px + MARGIN) / (ROW_HEIGHT + MARGIN)));
}

function rowsToPx(rows: number): number {
  return rows * ROW_HEIGHT + (rows - 1) * MARGIN;
}

/** Opening heights, in px, for a card whose spec carries no explicit height yet. */
const DEFAULT_HEIGHT_PX: Record<UiComponentSpec["type"], number> = {
  stat_cards: 140,
  chart: 340,
  comparison_table: 500,
  findings: 260,
  source_list: 260,
};

/** Default 12-col span per type in the structured grid preset (chart 5 + table 7 = one row). */
function gridDefaultSpan(c: UiComponentSpec, hasChart: boolean): number {
  switch (c.type) {
    case "stat_cards":
      return 12;
    case "chart":
      return 5;
    case "comparison_table":
      return hasChart ? 7 : 12;
    case "source_list":
      return 4;
    case "findings":
      return 8;
  }
}

/**
 * Seed a react-grid-layout `Layout` from the spec and the active preset. Explicit
 * sizes (dragged or voice-set) always win; the preset only decides the defaults and
 * the flow. The vertical compactor then packs whatever this returns, which is what
 * makes `masonry` read as a masonry wall without a masonry engine.
 */
function seedLayout(spec: UiSpec): Layout {
  const hasChart = spec.components.some((c) => c.type === "chart");
  const items: LayoutItem[] = [];
  let x = 0;
  let y = 0;

  const place = (c: UiComponentSpec, w: number, forcedX?: number) => {
    const h = pxToRows(c.size?.height ?? DEFAULT_HEIGHT_PX[c.type]);
    if (forcedX === undefined && x + w > COLS) {
      x = 0;
      y += 1;
    }
    items.push({ i: c.id, x: forcedX ?? x, y: y + items.length, w, h, minW: 2, minH: 3 });
    if (forcedX === undefined) x += w;
  };

  if (spec.layout === "focus") {
    const primary =
      spec.components.find((c) => c.type === "chart") ??
      spec.components.find((c) => c.type === "comparison_table") ??
      spec.components[0]!;
    for (const c of spec.components) {
      if (c.id === primary.id) {
        const h = pxToRows(c.size?.height ?? 560);
        items.push({ i: c.id, x: 0, y: 0, w: c.size?.span ?? 8, h, minW: 2, minH: 3 });
      } else {
        place(c, Math.min(c.size?.span ?? 4, 4), 8);
      }
    }
    return items;
  }

  if (spec.layout === "masonry") {
    for (const c of spec.components) place(c, c.size?.span ?? 4);
    return items;
  }

  // grid (structured)
  for (const c of spec.components) place(c, c.size?.span ?? gridDefaultSpan(c, hasChart));
  return items;
}

function DashboardGrid({
  spec,
  datasets,
  focusedId,
}: {
  spec: UiSpec;
  datasets: Record<string, Dataset>;
  focusedId: string | null;
}) {
  const { width, mounted, containerRef } = useContainerWidth();
  const layout = seedLayout(spec);

  /** One drag/resize gesture = one history entry, committed on release only. */
  const onResizeStop = (_layout: Layout, _old: LayoutItem | null, item: LayoutItem | null) => {
    if (!item) return;
    useLoom.getState().resizeComponent(item.i, {
      span: item.w,
      height: rowsToPx(item.h),
    });
  };

  const onDragStop = (finalLayout: Layout) => {
    const ordered = [...finalLayout].sort((a, b) => a.y - b.y || a.x - b.x).map((l) => l.i);
    useLoom.getState().reorderComponents(ordered);
  };

  return (
    <div ref={containerRef} className="dash">
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT, margin: [MARGIN, MARGIN], containerPadding: [0, 0] }}
          dragConfig={{ enabled: true, handle: ".drag-grip" }}
          resizeConfig={{ enabled: true, handles: ["se"] }}
          onResizeStop={onResizeStop}
          onDragStop={onDragStop}
        >
          {spec.components.map((c) => (
            <div key={c.id} className="dash-cell">
              <ComponentCard
                c={c}
                dataset={datasetFor(c, datasets)}
                focused={focusedId === c.id}
                weightClass={cardWeightClass(c.type) || undefined}
                fill
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}

function ComponentCard({
  c,
  dataset,
  focused,
  weightClass,
  fill = false,
}: {
  c: UiComponentSpec;
  dataset: Dataset | undefined;
  focused: boolean;
  weightClass?: string;
  /** Inside the grid the cell owns the size; the card fills it and flexes its content. */
  fill?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focused) {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focused]);

  const datasetMissing = requiresDataset(c) && !dataset;

  return (
    <section
      ref={ref}
      className={
        "card" +
        (focused ? " focused" : "") +
        (fill ? " card-fill" : "") +
        (weightClass ? " " + weightClass : "")
      }
      data-component-id={c.id}
    >
      {fill && <div className="drag-grip" title="Drag to move">⣿</div>}
      {c.title && <div className="card-title">{c.title}</div>}
      {datasetMissing ? (
        <p style={{ color: "var(--dim)", fontSize: 13 }}>Couldn&apos;t render {c.type}</p>
      ) : (
        <CardBoundary type={c.type}>
          {c.type === "chart" ? (
            <div className="chart-shell">{renderComponent(c, dataset)}</div>
          ) : (
            renderComponent(c, dataset)
          )}
        </CardBoundary>
      )}
    </section>
  );
}

function datasetFor(c: UiComponentSpec, datasets: Record<string, Dataset>): Dataset | undefined {
  if (!("datasetId" in c) || !c.datasetId) return undefined;
  return datasets[c.datasetId];
}

function requiresDataset(c: UiComponentSpec): boolean {
  switch (c.type) {
    case "comparison_table":
    case "chart":
    case "source_list":
      return true;
    case "findings":
      return !c.items;
    case "stat_cards":
      return false;
  }
}

/** Visual weight tier: chart/table carry primary emphasis, sources/findings stay quiet. */
function cardWeightClass(type: UiComponentSpec["type"]): string {
  switch (type) {
    case "chart":
    case "comparison_table":
      return "card-primary";
    case "source_list":
    case "findings":
      return "card-quiet";
    case "stat_cards":
      return "";
  }
}

function summarize(spec: UiSpec, datasets: Record<string, Dataset>): { sourceCount: number; rowCount: number } {
  const datasetIds = new Set<string>();
  for (const c of spec.components) {
    if ("datasetId" in c && c.datasetId) datasetIds.add(c.datasetId);
  }
  const sourceIds = new Set<string>();
  let rowCount = 0;
  for (const id of datasetIds) {
    const ds = datasets[id];
    if (!ds) continue;
    rowCount += ds.records.length;
    for (const s of ds.sources) sourceIds.add(s.id);
  }
  return { sourceCount: sourceIds.size, rowCount };
}

/** Stops one bad component spec (or a render-time throw) from blanking the whole canvas. */
class CardBoundary extends Component<{ type: string; children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[canvas] "${this.props.type}" failed to render`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return <p style={{ color: "var(--dim)", fontSize: 13 }}>Couldn&apos;t render {this.props.type}</p>;
    }
    return this.props.children;
  }
}
