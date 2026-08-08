import { useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "../canvas/components/Chart.js";
import { StatCards } from "../canvas/components/StatCards.js";
import { formatValue } from "../lib/filter.js";
import { useLoom } from "../store.js";
import { buildReportModel } from "./reportModel.js";
import type { ReportSection, ReportSource } from "./reportModel.js";

export function ReportPreview() {
  const spec = useLoom((state) => state.spec);
  const datasets = useLoom((state) => state.datasets);
  const tableViewFilters = useLoom((state) => state.tableViewFilters);
  const preview = useLoom((state) => state.reportPreview);
  const close = useLoom((state) => state.closeReportPreview);
  const requestPrint = useLoom((state) => state.requestReportPrint);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const handledPrintRequest = useRef(preview.printRequestId);
  const [printError, setPrintError] = useState<string | null>(null);

  const model = useMemo(
    () => spec && preview.openedAt ? buildReportModel(spec, datasets, tableViewFilters, preview.openedAt) : null,
    [datasets, preview.openedAt, spec, tableViewFilters],
  );

  useEffect(() => {
    if (!preview.open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const app = document.querySelector<HTMLElement>(".app");
    app?.setAttribute("inert", "");
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      app?.removeAttribute("inert");
      previousFocus.current?.focus();
    };
  }, [close, preview.open]);

  useEffect(() => {
    if (!preview.open || !model || preview.printRequestId === handledPrintRequest.current) return;
    handledPrintRequest.current = preview.printRequestId;
    setPrintError(null);
    const originalTitle = document.title;
    document.title = model.filename.replace(/\.pdf$/i, "");
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      document.title = originalTitle;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore, { once: true });
    const timeout = window.setTimeout(restore, 60_000);
    const frame = window.requestAnimationFrame(() => {
      try {
        if (typeof window.print !== "function") throw new Error("Printing is unavailable in this browser.");
        window.print();
      } catch {
        setPrintError("The browser could not open print preview. Please try the button again or use your browser’s Print command.");
        window.clearTimeout(timeout);
        restore();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [model, preview.open, preview.printRequestId]);

  if (!preview.open || !model) return null;

  return (
    <div className="report-preview" role="dialog" aria-modal="true" aria-labelledby="report-preview-title">
      <div className="report-toolbar">
        <div>
          <strong>PDF report preview</strong>
          <span>{model.rowCount.toLocaleString()} table rows · {model.sourceCount.toLocaleString()} sources</span>
        </div>
        <div className="report-toolbar-actions">
          <button className="report-button report-button-primary" onClick={requestPrint}>Print / Save PDF</button>
          <button ref={closeButton} className="report-button" onClick={close}>Close</button>
        </div>
      </div>
      {printError && <div className="report-print-error" role="alert">{printError}</div>}
      <div className="report-pasteboard">
        <article className="report-sheet" aria-label={model.title}>
          <header className="report-masthead">
            <div className="report-brand">Loom Research Report</div>
            <h1 id="report-preview-title">{model.title}</h1>
            <dl className="report-metadata">
              <div><dt>Generated</dt><dd>{formatDate(model.generatedAt)}</dd></div>
              <div><dt>Sources</dt><dd>{model.sourceCount.toLocaleString()}</dd></div>
              <div><dt>Table rows</dt><dd>{model.rowCount.toLocaleString()}</dd></div>
              {model.datasetCount > 1 && <div><dt>Datasets</dt><dd>{model.datasetCount}</dd></div>}
            </dl>
          </header>
          <main className="report-content">
            {model.sections.map((section) => <ReportSectionView key={section.id} section={section} />)}
          </main>
          <footer className="report-footer">
            Generated from “{model.title}” on {formatDate(model.generatedAt)}. This report reflects the dashboard, filters, sorting, and highlights visible when the preview was opened.
          </footer>
        </article>
      </div>
    </div>
  );
}

function ReportSectionView({ section }: { section: ReportSection }) {
  const title = section.title || defaultTitle(section.type);
  return (
    <section className={`report-section report-section-${section.type}`}>
      <h2>{title}</h2>
      {section.type === "stat_cards" && <StatCards spec={section.spec} />}
      {section.type === "chart" && (section.dataset ? <Chart spec={section.spec} dataset={section.dataset} report /> : <Unavailable />)}
      {section.type === "comparison_table" && <ReportTable section={section} />}
      {section.type === "findings" && <ReportFindings section={section} />}
      {section.type === "source_list" && <ReportSources sources={section.sources} unavailable={section.unavailable} />}
      {section.type === "image_gallery" && <ReportImages section={section} />}
    </section>
  );
}

function ReportTable({ section }: { section: Extract<ReportSection, { type: "comparison_table" }> }) {
  if (!section.dataset) return <Unavailable />;
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <caption>{section.summary}</caption>
        <thead><tr>{section.fields.map((field) => <th key={field.key} className={isNumeric(field.type) ? "report-number" : undefined}>{field.label}</th>)}</tr></thead>
        <tbody>
          {section.rows.length ? section.rows.map((row, index) => (
            <tr key={index} className={row.highlighted ? "report-highlighted" : undefined}>
              {section.fields.map((field, columnIndex) => (
                <td key={field.key} className={isNumeric(field.type) ? "report-number" : undefined}>
                  {columnIndex === 0 && row.highlighted && <span className="report-highlight-marker" aria-label="Highlighted row">Highlighted</span>}
                  {formatValue(row.record[field.key] ?? null, field.type, field.unit)}
                </td>
              ))}
            </tr>
          )) : <tr><td colSpan={Math.max(section.fields.length, 1)} className="report-empty">No rows match the current filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ReportFindings({ section }: { section: Extract<ReportSection, { type: "findings" }> }) {
  if (section.unavailable) return <Unavailable />;
  if (!section.items.length) return <p className="report-empty">No findings available.</p>;
  return <ol className="report-findings">{section.items.map((item, index) => <li key={index}><span>{item.text}</span>{item.sourceNumbers.length > 0 && <sup>{item.sourceNumbers.map((number) => `[${number}]`).join(" ")}</sup>}</li>)}</ol>;
}

function ReportSources({ sources, unavailable }: { sources: ReportSource[]; unavailable: boolean }) {
  if (unavailable) return <Unavailable />;
  if (!sources.length) return <p className="report-empty">No sources available.</p>;
  return <ol className="report-sources">{sources.map((source) => (
    <li key={source.id} value={source.number}>
      <a href={source.url} target="_blank" rel="noreferrer">{source.title || source.domain || source.url}</a>
      <span>{source.domain}{source.error ? " · Could not read" : source.fetchedAt ? " · Read" : " · Pending"}</span>
      <a className="report-source-url" href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
    </li>
  ))}</ol>;
}

function ReportImages({ section }: { section: Extract<ReportSection, { type: "image_gallery" }> }) {
  if (section.unavailable) return <Unavailable />;
  if (!section.images.length) return <p className="report-empty">No images were collected for this report.</p>;
  return <div className="report-images">{section.images.map((image, index) => (
    <figure key={`${image.src}-${index}`}>
      <img src={image.src} alt={image.alt ?? ""} />
      {(image.alt || image.sourceNumber !== undefined) && (
        <figcaption>
          {image.alt}
          {image.sourceNumber !== undefined && <sup>{`[${image.sourceNumber}]`}</sup>}
        </figcaption>
      )}
    </figure>
  ))}</div>;
}

function Unavailable() {
  return <p className="report-empty">This section’s data is no longer available.</p>;
}

function defaultTitle(type: ReportSection["type"]): string {
  return ({
    stat_cards: "Summary",
    comparison_table: "Comparison",
    chart: "Chart",
    findings: "Key findings",
    source_list: "Sources",
    image_gallery: "Images",
  })[type];
}

function isNumeric(type: string): boolean {
  return type === "number" || type === "currency";
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}
