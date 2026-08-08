import { Component, useEffect, useRef } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { Dataset } from "../contract/dataset.js";
import type { UiComponentSpec, UiSpec } from "../contract/ui.js";
import { renderComponent } from "./registry.js";
import { useLoom } from "../store.js";

const EXAMPLE_PROMPTS = [
  "Compare 2-bedroom prices in Dubai Marina and JVC",
  "What are the top AI hardware startups this year",
  "Summarise these three pricing pages",
];

export function Canvas() {
  const spec = useLoom((s) => s.spec);
  const datasets = useLoom((s) => s.datasets);
  const focusedId = useLoom((s) => s.focusedId);
  const status = useLoom((s) => s.status);
  const progress = useLoom((s) => s.progress);
  const canUndo = useLoom((s) => s.history.length > 0);

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
            <h2>Say it, watch it take shape.</h2>
            <p>
              Ask a research question out loud or type it. Scry reads live web pages, pulls out the
              numbers, and builds a dashboard here while it talks you through what it finds.
            </p>
            <p className="empty-hint">Press Start in the left rail to talk, or try one of these:</p>
            <div>
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  type="button"
                  className="chip chip-action"
                  key={prompt}
                  onClick={() => useLoom.getState().setQueuedPrompt(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    );
  }

  const { sourceCount, rowCount } = summarize(spec, datasets);
  const hasChart = spec.components.some((c) => c.type === "chart");

  return (
    <main className="canvas">
      <div className="canvas-head">
        <div>
          <div className="canvas-title">{spec.title ?? "Results"}</div>
          <div className="canvas-sub">
            {sourceCount} source{sourceCount === 1 ? "" : "s"} · {rowCount} row{rowCount === 1 ? "" : "s"}
          </div>
        </div>
        {/* Voice-only actions surfaced as controls so keyboard/mouse users aren't second-class. */}
        <div className="canvas-actions">
          <button
            type="button"
            className="canvas-action-btn"
            disabled={!canUndo}
            onClick={() => {
              const prev = useLoom.getState().undo();
              useLoom.getState().addMessage({
                role: "system",
                kind: "status",
                text: prev ? "Reverted the last change." : "Nothing to undo.",
              });
            }}
          >
            Undo
          </button>
          <button
            type="button"
            className="canvas-action-btn"
            onClick={() => {
              const cleared = useLoom.getState().clearCanvas();
              useLoom.getState().addMessage({
                role: "system",
                kind: "status",
                text: cleared ? "Canvas cleared." : "Canvas is already empty.",
              });
            }}
          >
            Clear
          </button>
        </div>
      </div>
      {spec.layout === "grid" ? (
        <div className="grid">
          {spec.components.map((c) => (
            <ComponentCard
              key={c.id}
              c={c}
              dataset={datasetFor(c, datasets)}
              focused={focusedId === c.id}
              spanClass={[gridSpan(c, hasChart), cardWeightClass(c.type)].filter(Boolean).join(" ")}
            />
          ))}
        </div>
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

function ComponentCard({
  c,
  dataset,
  focused,
  spanClass,
}: {
  c: UiComponentSpec;
  dataset: Dataset | undefined;
  focused: boolean;
  spanClass?: string;
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
      className={"card" + (focused ? " focused" : "") + (spanClass ? " " + spanClass : "")}
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
