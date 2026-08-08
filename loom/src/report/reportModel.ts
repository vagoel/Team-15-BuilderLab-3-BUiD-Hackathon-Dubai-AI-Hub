import type { DataRecord, Dataset, FieldSpec, Filter, Source, UiComponentSpec, UiSpec } from "../contract/index.js";
import type { TableViewFilterState } from "../store.js";
import { applyFilters, selectRows } from "../lib/filter.js";

type TableSpec = Extract<UiComponentSpec, { type: "comparison_table" }>;
type ChartSpec = Extract<UiComponentSpec, { type: "chart" }>;
type StatSpec = Extract<UiComponentSpec, { type: "stat_cards" }>;
type ImageGallerySpec = Extract<UiComponentSpec, { type: "image_gallery" }>;

export interface ReportSource extends Source {
  number: number;
  domain: string;
}

export interface ReportTableRow {
  record: DataRecord;
  highlighted: boolean;
}

export type ReportSection =
  | { id: string; type: "stat_cards"; title?: string; spec: StatSpec }
  | { id: string; type: "comparison_table"; title?: string; spec: TableSpec; dataset?: Dataset; fields: FieldSpec[]; rows: ReportTableRow[]; summary: string }
  | { id: string; type: "chart"; title?: string; spec: ChartSpec; dataset?: Dataset }
  | { id: string; type: "findings"; title?: string; items: { text: string; sourceNumbers: number[] }[]; unavailable: boolean }
  | { id: string; type: "source_list"; title?: string; sources: ReportSource[]; unavailable: boolean }
  | {
      id: string;
      type: "image_gallery";
      title?: string;
      spec: ImageGallerySpec;
      images: { src: string; alt?: string; sourceNumber?: number }[];
      unavailable: boolean;
    };

export interface ReportModel {
  title: string;
  generatedAt: number;
  sections: ReportSection[];
  sources: ReportSource[];
  sourceCount: number;
  rowCount: number;
  datasetCount: number;
  filename: string;
}

/** Matches the on-screen gallery's own default, so print and screen agree. */
const DEFAULT_GALLERY_IMAGES = 12;

export function buildReportModel(
  spec: UiSpec,
  datasets: Record<string, Dataset>,
  tableViewFilters: Record<string, TableViewFilterState>,
  generatedAt: number,
): ReportModel {
  const datasetIds = new Set<string>();
  for (const component of spec.components) {
    if ("datasetId" in component && component.datasetId) datasetIds.add(component.datasetId);
  }

  const sources = collectSources(
    [...datasetIds].map((id) => datasets[id]).filter((dataset): dataset is Dataset => dataset !== undefined),
  );
  const sourceNumbers = new Map(sources.map((source) => [source.id, source.number]));
  let rowCount = 0;

  const sections = spec.components.map((component): ReportSection => {
    const dataset = "datasetId" in component && component.datasetId ? datasets[component.datasetId] : undefined;
    switch (component.type) {
      case "stat_cards":
        return { id: component.id, type: component.type, title: component.title, spec: component };
      case "comparison_table": {
        const fields = resolveFields(component, dataset);
        const manual = tableViewFilters[component.id];
        const manualFilters = manual?.datasetId === component.datasetId ? manual.filters : [];
        const rows = dataset ? selectRows(dataset.records, [...component.filters, ...manualFilters], component.sort, dataset.fields) : [];
        const reportRows = rows.map((record) => ({
          record,
          highlighted: component.highlights.some((filter) => applyFilters([record], [filter]).length === 1),
        }));
        rowCount += reportRows.length;
        return {
          id: component.id,
          type: component.type,
          title: component.title,
          spec: component,
          dataset,
          fields,
          rows: reportRows,
          summary: tableSummary(reportRows.length, dataset?.records.length ?? 0, component.filters, manualFilters, component.sort),
        };
      }
      case "chart":
        return { id: component.id, type: component.type, title: component.title, spec: component, dataset };
      case "findings": {
        const items = component.items ?? dataset?.findings ?? [];
        return {
          id: component.id,
          type: component.type,
          title: component.title,
          unavailable: !component.items && !dataset,
          items: items.map((item) => ({
            text: item.text,
            sourceNumbers: item.sourceIds.map((id) => sourceNumbers.get(id)).filter((number): number is number => number !== undefined),
          })),
        };
      }
      case "source_list":
        return {
          id: component.id,
          type: component.type,
          title: component.title,
          unavailable: !dataset,
          sources: dataset ? dataset.sources.map((source) => sources.find((item) => item.id === source.id)).filter((source): source is ReportSource => Boolean(source)) : [],
        };
      case "image_gallery": {
        // A printed gallery carries its attribution as the same bracketed number the
        // rest of the report uses, so a picture on paper is still traceable to a page.
        const images = (dataset?.images ?? []).slice(0, component.max ?? DEFAULT_GALLERY_IMAGES).map((image) => ({
          src: image.src,
          ...(image.alt ? { alt: image.alt } : {}),
          ...(sourceNumbers.has(image.sourceId) ? { sourceNumber: sourceNumbers.get(image.sourceId) } : {}),
        }));
        return {
          id: component.id,
          type: component.type,
          title: component.title,
          spec: component,
          images,
          unavailable: !dataset,
        };
      }
    }
  });

  const title = spec.title?.trim() || "Loom Research Report";
  return {
    title,
    generatedAt,
    sections,
    sources,
    sourceCount: sources.length,
    rowCount,
    datasetCount: datasetIds.size,
    filename: `${sanitizeFilename(title)}.pdf`,
  };
}

export function sanitizeFilename(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "loom-research-report";
}

function collectSources(datasets: Dataset[]): ReportSource[] {
  const byId = new Map<string, Source>();
  for (const dataset of datasets) {
    for (const source of dataset.sources) if (!byId.has(source.id)) byId.set(source.id, source);
  }
  return [...byId.values()].map((source, index) => ({
    ...source,
    number: index + 1,
    domain: sourceDomain(source.url),
  }));
}

function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function resolveFields(spec: TableSpec, dataset: Dataset | undefined): FieldSpec[] {
  if (!dataset) return [];
  const byKey = new Map(dataset.fields.map((field) => [field.key, field]));
  const keys = spec.columns.length ? spec.columns : dataset.fields.map((field) => field.key);
  return keys.map((key) => byKey.get(key) ?? { key, label: key, type: "string" });
}

function tableSummary(
  visible: number,
  total: number,
  voiceFilters: Filter[],
  manualFilters: Filter[],
  sort?: { field: string; dir: "asc" | "desc" },
): string {
  const parts = [`${visible.toLocaleString()} of ${total.toLocaleString()} rows`];
  const filterCount = voiceFilters.length + manualFilters.length;
  if (filterCount) parts.push(`${filterCount} active filter${filterCount === 1 ? "" : "s"}`);
  if (sort) parts.push(`sorted by ${sort.field} ${sort.dir === "asc" ? "ascending" : "descending"}`);
  return parts.join(" · ");
}
