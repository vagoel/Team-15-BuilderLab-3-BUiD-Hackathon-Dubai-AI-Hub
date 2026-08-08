import { Component, useEffect, useRef } from "react";
import type { CSSProperties, ErrorInfo, ReactNode } from "react";
import { Masonry } from "masonic";
import type { Dataset } from "../contract/dataset.js";
import type { LayoutKind, UiComponentSpec, UiSpec } from "../contract/ui.js";
import { renderComponent } from "./registry.js";
import { ResizeHandle } from "./ResizeHandle.js";
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
      {spec.layout === "masonry" ? (
        <MasonryLayout spec={spec} datasets={datasets} focusedId={focusedId} />
      ) : spec.layout === "focus" ? (
        <FocusLayout spec={spec} datasets={datasets} focusedId={focusedId} />
      ) : spec.layout === "grid" ? (
        <GridLayout spec={spec} datasets={datasets} focusedId={focusedId} />
      ) : (
        <div className="stack">
          {spec.components.map((c) => (
            <ComponentCard
              key={c.id}
              c={c}
              dataset={datasetFor(c, datasets)}
              focused={focusedId === c.id}
              spanClass={cardWeightClass(c.type) || undefined}
            />
          ))}
        </div>
      )}
    </main>
  );
}

interface LayoutProps {
  spec: UiSpec;
  datasets: Record<string, Dataset>;
  focusedId: string | null;
}

function GridLayout({ spec, datasets, focusedId }: LayoutProps) {
  const hasChart = spec.components.some((c) => c.type === "chart");
  return (
    <div className="grid">
      {spec.components.map((c) => (
        <ComponentCard
          key={c.id}
          c={c}
          dataset={datasetFor(c, datasets)}
          focused={focusedId === c.id}
          spanClass={[c.size?.span ? "" : gridSpan(c, hasChart), cardWeightClass(c.type)]
            .filter(Boolean)
            .join(" ")}
          style={c.size?.span ? { gridColumn: `span ${c.size.span}` } : undefined}
          resizable="both"
        />
      ))}
    </div>
  );
}

/**
 * Masonry packs the cards into columns by their measured height — masonic
 * re-measures through its ResizeObserver, so a card growing (drag, filter change,
 * rows streaming in) re-flows the wall around it. `overscanBy` is effectively
 * infinite: a dashboard has at most ten cards, so windowing would only ever hurt —
 * and it frees the grid from caring that the canvas scrolls in an inner box rather
 * than the window masonic watches by default.
 */
function MasonryLayout({ spec, datasets, focusedId }: LayoutProps) {
  return (
    <Masonry
      // masonic caches item positions; remount when the set of cards changes so a
      // removed card doesn't leave a hole where its cached position was.
      key={spec.components.map((c) => c.id).join("|")}
      items={spec.components}
      itemKey={(item) => item.id}
      columnGutter={16}
      columnWidth={340}
      overscanBy={Number.POSITIVE_INFINITY}
      render={({ data }) => (
        <ComponentCard
          c={data}
          dataset={datasetFor(data, datasets)}
          focused={focusedId === data.id}
          spanClass={cardWeightClass(data.type) || undefined}
          resizable="height"
        />
      )}
    />
  );
}

/**
 * Focus: one primary artifact large on the left, everything else in a quiet rail.
 * The chart is the natural spotlight; failing that the table; failing that whatever
 * came first.
 */
function FocusLayout({ spec, datasets, focusedId }: LayoutProps) {
  const primary =
    spec.components.find((c) => c.type === "chart") ??
    spec.components.find((c) => c.type === "comparison_table") ??
    spec.components[0]!;
  const rest = spec.components.filter((c) => c.id !== primary.id);

  return (
    <div className="focus-layout">
      <div className="focus-main">
        <ComponentCard
          c={primary}
          dataset={datasetFor(primary, datasets)}
          focused={focusedId === primary.id}
          spanClass="card-primary"
          resizable="height"
        />
      </div>
      <div className="focus-rail">
        {rest.map((c) => (
          <ComponentCard
            key={c.id}
            c={c}
            dataset={datasetFor(c, datasets)}
            focused={focusedId === c.id}
            spanClass={cardWeightClass(c.type) || undefined}
            resizable="height"
          />
        ))}
      </div>
    </div>
  );
}

function ComponentCard({
  c,
  dataset,
  focused,
  spanClass,
  style,
  resizable = "none",
}: {
  c: UiComponentSpec;
  dataset: Dataset | undefined;
  focused: boolean;
  spanClass?: string;
  style?: CSSProperties;
  resizable?: "both" | "height" | "none";
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focused) {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focused]);

  const datasetMissing = requiresDataset(c) && !dataset;
  const sized = c.size?.height !== undefined;

  return (
    <section
      ref={ref}
      className={
        "card" +
        (focused ? " focused" : "") +
        (sized ? " card-sized" : "") +
        (spanClass ? " " + spanClass : "")
      }
      style={sized ? { ...style, height: c.size!.height } : style}
      data-component-id={c.id}
    >
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
      {resizable !== "none" && (
        <ResizeHandle componentId={c.id} cardRef={ref} allowWidth={resizable === "both"} />
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

/**
 * Column spans for the 12-col grid. Chart + table are sized to sum to 12 so they sit
 * side by side on one row (5 + 7 — the table is the denser artifact, it gets more
 * room) instead of the table wrapping onto its own row with a dead gap behind the
 * chart. Findings + source list do the same at 8 + 4.
 */
function gridSpan(c: UiComponentSpec, hasChart: boolean): string {
  switch (c.type) {
    case "stat_cards":
      return "span-12";
    case "chart":
      return "span-5";
    case "comparison_table":
      return hasChart ? "span-7" : "span-12";
    case "source_list":
      return "span-4";
    case "findings":
      return "span-8";
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
