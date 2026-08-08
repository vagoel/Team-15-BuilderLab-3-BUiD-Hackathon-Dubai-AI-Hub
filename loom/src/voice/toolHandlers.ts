import { z } from "zod";
import {
  DeepenParams,
  FocusComponentParams,
  GetUiStateParams,
  ReadSourceParams,
  MockDataParams,
  RenderUiParams,
  ResearchParams,
  AddComponentParams,
  MoveComponentParams,
  RemoveComponentParams,
  ClearCanvasParams,
  ExportDataParams,
  HighlightRowsParams,
  ScrollComponentParams,
  ScrollPageParams,
  UndoParams,
  SetFilterParams,
  SortTableParams,
  TOOLS,
  UpdateComponentParams,
  type ToolName,
} from "../contract/tools.js";
import { buildComponent, buildLayout, defaultLayout } from "../canvas/autoLayout.js";
import { csvToTable } from "../research/csv.js";
import { applyFilters } from "../lib/filter.js";
import { useLoom } from "../store.js";
import { deepenResearch, getDataset, readSource, runResearch } from "../research/index.js";
import type { ResearchHooks } from "../research/index.js";
import { UiComponentSpec } from "../contract/ui.js";
import type { Dataset } from "../contract/index.js";

/**
 * One handler per entry in `TOOLS`, bound to the store and the research engine.
 *
 * Every handler validates its own params against the matching zod schema and NEVER
 * throws — a thrown error kills the voice turn, so a validation failure or a runtime
 * error is always turned into a short plain-language string instead. Every call also
 * leaves a line in the chat transcript so tool activity is visible, not just spoken.
 */

// ---------------------------------------------------------------------------
// Defensive param parsing
//
// The model sometimes sends a JSON *string* where the schema expects an object or
// array — the single most common real-world tool-calling failure. We walk the zod
// schema alongside the raw value and JSON.parse any string sitting where a structured
// value belongs (recursing into nested objects/arrays), then validate normally.
// ---------------------------------------------------------------------------

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s: z.ZodTypeAny = schema;
  for (;;) {
    // The generic default on ZodOptional/ZodNullable/ZodDefault is zod's internal
    // `core.$ZodType`, not the classic `z.ZodTypeAny` — `instanceof` narrowing picks
    // that default, so `.unwrap()`/`.removeDefault()` come back typed slightly
    // narrower than what we store in `s`. The cast is safe: these really are the
    // same runtime schema objects, just re-widened to the type we walk with.
    if (s instanceof z.ZodOptional) {
      s = s.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (s instanceof z.ZodNullable) {
      s = s.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (s instanceof z.ZodDefault) {
      s = s.removeDefault() as z.ZodTypeAny;
      continue;
    }
    return s;
  }
}

function tryJsonParse(value: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function coerceStructured(schema: z.ZodTypeAny, value: unknown): unknown {
  const inner = unwrapSchema(schema);

  if (typeof value === "string") {
    const wantsStructured =
      inner instanceof z.ZodObject ||
      inner instanceof z.ZodArray ||
      inner instanceof z.ZodRecord ||
      inner instanceof z.ZodDiscriminatedUnion;
    if (!wantsStructured) return value;
    const parsed = tryJsonParse(value);
    if (!parsed.ok) return value;
    value = parsed.data;
  }

  if (inner instanceof z.ZodObject && value && typeof value === "object" && !Array.isArray(value)) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const key of Object.keys(shape)) {
      if (key in out) out[key] = coerceStructured(shape[key]!, out[key]);
    }
    return out;
  }

  if (inner instanceof z.ZodArray && Array.isArray(value)) {
    const element = inner.element as z.ZodTypeAny;
    return value.map((item) => coerceStructured(element, item));
  }

  return value;
}

function formatPath(path: PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || "(root)";
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

function parseParams<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const input = raw === undefined || raw === null ? {} : raw;
  const coerced = coerceStructured(schema, input);
  const result = schema.safeParse(coerced);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  if (!issue) return { ok: false, error: "invalid input" };
  return { ok: false, error: `${formatPath(issue.path)} ${issue.message}` };
}

// ---------------------------------------------------------------------------
// Chat transcript logging
// ---------------------------------------------------------------------------

function toolMessage(text: string): void {
  useLoom.getState().addMessage({ role: "system", kind: "tool", text });
}

function errorMessage(tool: string, detail: string): string {
  const msg = `${tool} failed: ${detail}`;
  toolMessage(msg);
  return msg;
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleResearch(raw: unknown): Promise<unknown> {
  const parsed = parseParams(ResearchParams, raw);
  if (!parsed.ok) return errorMessage("research", parsed.error);
  const { question, seedUrls, fields, mode = "replace" } = parsed.data;
  const append = mode === "add";

  toolMessage(
    `research → "${question}" across ${seedUrls.length} source${seedUrls.length === 1 ? "" : "s"} ` +
      `(fields: ${fields.map((f) => f.key).join(", ")})`,
  );

  const store = useLoom.getState();
  store.setStatus("researching");
  store.setProgress({ label: "Starting research", done: 0, total: seedUrls.length });

  const hooks: ResearchHooks = {
    onStart: (datasetId) => {
      // Extraction runs ~20s against a cold page. Without this the canvas is blank
      // for that whole stretch and the app looks dead. Mount the source list right
      // away so rows appear in about a second and fill in as pages land; the agent
      // replaces this with the real dashboard when research returns.
      //
      // Only when the canvas is empty — if a dashboard is already up, leaving it
      // there beats blanking it to show three loading rows.
      if (useLoom.getState().spec) return;
      useLoom.getState().setSpec({
        title: question,
        layout: "stack",
        components: [
          { id: "provisional_sources", type: "source_list", title: "Reading now", datasetId },
        ],
      });
      useLoom.getState().setStatus("researching");
    },
    onProgress: (done, total, label) => {
      useLoom.getState().setProgress({ label, done, total });
    },
    onSourceFound: (s) => {
      toolMessage(`found source: ${s.title || s.url}`);
    },
    onSourceRead: (sourceId, ms, cached) => {
      toolMessage(`read ${sourceId} in ${ms}ms${cached ? " (cached)" : ""}`);
    },
    onSourceFailed: (sourceId, error) => {
      toolMessage(`could not read ${sourceId}: ${error}`);
    },
  };

  try {
    const summary = await runResearch({ question, seedUrls, fields }, hooks);
    const full = getDataset(summary.datasetId);
    if (full) useLoom.getState().addDataset(full);
    useLoom.getState().setProgress(null);
    useLoom.getState().setStatus("ready");
    toolMessage(`research done: ${summary.recordCount} records from ${summary.sourceCount} sources`);

    // Mount a dashboard here rather than waiting for the agent to ask for one. The
    // screen filling up is the whole product, and it must not depend on the model
    // getting a follow-up tool call right. render_ui then only handles changes.
    // In add mode the new dataset joins the report instead of replacing it — same
    // path mock_data takes, so the two tools cannot drift.
    if (full) {
      const spec = mountDataset(full, append);
      toolMessage(
        `${append ? "added to report" : "auto-rendered"} → ${spec.components.map((c) => c.type).join(", ")}`,
      );
      return {
        ...summary,
        rendered: spec.components.map((c) => c.type),
        mode,
        note:
          (append
            ? "The new research has been ADDED to the existing report. "
            : "A dashboard is already on screen showing " +
              `${spec.components.map((c) => c.type).join(", ")}. `) +
          "Do NOT call render_ui now — just say one short sentence about what the user can see.",
      };
    }
    return summary;
  } catch (err) {
    useLoom.getState().setProgress(null);
    useLoom.getState().setStatus(useLoom.getState().spec ? "ready" : "idle");
    return errorMessage("research", describeErr(err));
  }
}

async function handleDeepen(raw: unknown): Promise<unknown> {
  const parsed = parseParams(DeepenParams, raw);
  if (!parsed.ok) return errorMessage("deepen", parsed.error);
  const { datasetId, angle } = parsed.data;

  toolMessage(`deepen → ${datasetId}: ${angle}`);

  const store = useLoom.getState();
  store.setStatus("researching");
  store.setProgress({ label: `Deepening: ${angle}`, done: 0, total: 1 });

  const hooks: ResearchHooks = {
    onProgress: (done, total, label) => {
      useLoom.getState().setProgress({ label, done, total });
    },
    onSourceFound: (s) => {
      toolMessage(`found source: ${s.title || s.url}`);
    },
    onSourceRead: (sourceId, ms, cached) => {
      toolMessage(`read ${sourceId} in ${ms}ms${cached ? " (cached)" : ""}`);
    },
    onSourceFailed: (sourceId, error) => {
      toolMessage(`could not read ${sourceId}: ${error}`);
    },
  };

  try {
    const summary = await deepenResearch({ datasetId, angle }, hooks);
    const full = getDataset(summary.datasetId);
    if (full) useLoom.getState().addDataset(full);
    useLoom.getState().setProgress(null);
    useLoom.getState().setStatus("ready");
    toolMessage(`deepen done: ${summary.recordCount} records from ${summary.sourceCount} sources`);
    return {
      ...summary,
      note:
        "The dataset was extended in place — every component showing it has already " +
        "updated. Do NOT call render_ui. Say one short sentence about what changed.",
    };
  } catch (err) {
    useLoom.getState().setProgress(null);
    useLoom.getState().setStatus(useLoom.getState().spec ? "ready" : "idle");
    return errorMessage("deepen", describeErr(err));
  }
}

async function handleReadSource(raw: unknown): Promise<unknown> {
  const parsed = parseParams(ReadSourceParams, raw);
  if (!parsed.ok) return errorMessage("read_source", parsed.error);
  const { sourceId } = parsed.data;

  toolMessage(`read_source → ${sourceId}`);

  try {
    const page = await readSource(sourceId);
    const excerpt = page.markdown.length > 1500 ? `${page.markdown.slice(0, 1500)}…` : page.markdown;
    return { title: page.title, url: page.url, excerpt };
  } catch (err) {
    return errorMessage("read_source", describeErr(err));
  }
}

async function handleAddComponent(raw: unknown): Promise<unknown> {
  const parsed = parseParams(AddComponentParams, raw);
  if (!parsed.ok) return errorMessage("add_component", parsed.error);
  const { datasetId, type, position } = parsed.data;

  const dataset = useLoom.getState().datasets[datasetId];
  if (!dataset) {
    const known = Object.keys(useLoom.getState().datasets);
    return errorMessage(
      "add_component",
      `unknown datasetId ${datasetId}. ` + (known.length ? `Use one of: ${known.join(", ")}` : "No dataset yet."),
    );
  }

  // Same builder the auto-layout uses, so an added component is indistinguishable
  // from one that was there from the start.
  const base = buildComponent(dataset, type);
  if (!base) {
    return errorMessage("add_component", `this data cannot support a ${type} (a chart needs a numeric column)`);
  }

  // A second table or chart is a perfectly reasonable ask — two views of the same
  // data, filtered differently. Refusing because the default id was taken made the
  // agent say "I can't add another one", which is not true, so mint a fresh id.
  const taken = new Set(useLoom.getState().spec?.components.map((c) => c.id) ?? []);
  let component = base;
  if (taken.has(base.id)) {
    let n = 2;
    while (taken.has(`${base.id}_${n}`)) n++;
    component = buildComponent(dataset, type, `${base.id}_${n}`)!;
  }

  const ok = useLoom.getState().addComponent(component, position);
  if (!ok) return errorMessage("add_component", "the dashboard is full — remove something first");
  toolMessage(`add_component → ${type}`);
  return `Added the ${type.replace(/_/g, " ")}.`;
}

async function handleRemoveComponent(raw: unknown): Promise<unknown> {
  const parsed = parseParams(RemoveComponentParams, raw);
  if (!parsed.ok) return errorMessage("remove_component", parsed.error);

  const ok = useLoom.getState().removeComponent(parsed.data.id);
  if (!ok) {
    return errorMessage(
      "remove_component",
      `could not remove ${parsed.data.id} — either no component has that id, or it is the last one left`,
    );
  }
  toolMessage(`remove_component → ${parsed.data.id}`);
  return `Removed ${parsed.data.id}.`;
}

async function handleMoveComponent(raw: unknown): Promise<unknown> {
  const parsed = parseParams(MoveComponentParams, raw);
  if (!parsed.ok) return errorMessage("move_component", parsed.error);

  const ok = useLoom.getState().moveComponent(parsed.data.id, parsed.data.position);
  if (!ok) return errorMessage("move_component", `no component with id ${parsed.data.id}`);
  toolMessage(`move_component → ${parsed.data.id} to slot ${parsed.data.position}`);
  return `Moved ${parsed.data.id}.`;
}

/**
 * `CSS.escape` is standard in every browser Loom targets, but a handler must never
 * throw regardless — fall back to a manual escape so a missing or misbehaving
 * `CSS.escape` degrades to "selector didn't match" instead of taking the handler
 * down with it.
 */
function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    try {
      return CSS.escape(value);
    } catch {
      // fall through to the manual escape below
    }
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/**
 * Scrolls inside a component's own scroll container.
 *
 * This reaches into the DOM rather than going through the store, deliberately: scroll
 * offset is transient view state that nothing else reads, and putting it in the store
 * would mean every scroll re-rendered the canvas. "Scroll down a bit" previously had
 * no tool at all, so the agent answered it with focus_component and claimed success.
 *
 * Everything past this point touches the live DOM, which can change out from under us
 * between the id check above and the scroll below (a re-render can swap or remove the
 * node entirely) — so it is wrapped in one try/catch. A thrown DOM exception here must
 * never escape the handler and kill the voice turn.
 */
async function handleScrollComponent(raw: unknown): Promise<unknown> {
  const parsed = parseParams(ScrollComponentParams, raw);
  if (!parsed.ok) return errorMessage("scroll_component", parsed.error);
  const { id, to, amount } = parsed.data;

  const exists = useLoom.getState().spec?.components.some((c) => c.id === id) ?? false;
  if (!exists) return errorMessage("scroll_component", `no component with id ${id}`);

  try {
    const host = document.querySelector(`[data-component-id="${escapeAttrValue(id)}"]`);
    const box =
      host?.querySelector<HTMLElement>(".scroll") ??
      Array.from(host?.querySelectorAll<HTMLElement>("*") ?? []).find(
        (el) => el.scrollHeight > el.clientHeight + 8,
      );

    if (!box) return `The ${id} does not scroll — everything in it is already visible.`;

    const page = Math.max(80, box.clientHeight - 40) * (amount ?? 1);
    const before = box.scrollTop;
    const target =
      to === "top" ? 0 : to === "bottom" ? box.scrollHeight : before + (to === "down" ? page : -page);

    const clamped = Math.max(0, Math.min(target, box.scrollHeight - box.clientHeight));
    box.scrollTo({ top: clamped, behavior: "smooth" });

    settleScroll(box, clamped);

    toolMessage(`scroll_component → ${id} ${to}`);

    const atEnd = to === "down" && before + page >= box.scrollHeight - box.clientHeight;
    if (atEnd) return "Scrolled to the bottom — that is the end of the rows.";
    return `Scrolled ${to}.`;
  } catch (err) {
    return errorMessage("scroll_component", describeErr(err));
  }
}

/**
 * Make sure a smooth scroll actually landed.
 *
 * `scrollTo({behavior:"smooth"})` is cancelled outright by a re-render and can stall
 * partway on a small or freshly-laid-out element. Both leave the agent claiming it
 * scrolled when the screen did not move — confidently wrong and invisible in the
 * transcript. Retry, then stop animating and just be correct.
 */
const pendingSettles = new WeakMap<HTMLElement, number>();

function settleScroll(box: HTMLElement, target: number): void {
  // Two scrolls in quick succession would otherwise leave two settle timers running,
  // and the older one drags the element back to where it was going before. Observed
  // directly: "scroll to the bottom" then "back to the top" ended up at the bottom.
  const pending = pendingSettles.get(box);
  if (pending !== undefined) clearTimeout(pending);

  const check = (attempt: number) => {
    try {
      if (Math.abs(box.scrollTop - target) <= 4) {
        pendingSettles.delete(box);
        return;
      }
      if (attempt >= 2) {
        box.scrollTop = target;
        pendingSettles.delete(box);
        return;
      }
      pendingSettles.set(box, window.setTimeout(() => check(attempt + 1), 200));
    } catch {
      // The node can go away mid-retry; nothing to rescue.
      pendingSettles.delete(box);
    }
  };
  // 120ms, not 300: where smooth scrolling is unsupported or disabled — headless
  // browsers, reduced-motion settings — nothing moves at all, and the first check is
  // the entire latency the user feels before the screen responds.
  pendingSettles.set(box, window.setTimeout(() => check(0), 120));
}

/** Scrolls the canvas itself. `scroll_component` scrolls inside one card. */
async function handleScrollPage(raw: unknown): Promise<unknown> {
  const parsed = parseParams(ScrollPageParams, raw);
  if (!parsed.ok) return errorMessage("scroll_page", parsed.error);
  const { to } = parsed.data;

  try {
    const box = document.querySelector<HTMLElement>(".canvas");
    if (!box) return "The dashboard is not on screen yet.";

    const page = Math.max(120, box.clientHeight - 80);
    const target =
      to === "top" ? 0 : to === "bottom" ? box.scrollHeight : box.scrollTop + (to === "down" ? page : -page);
    const clamped = Math.max(0, Math.min(target, box.scrollHeight - box.clientHeight));

    if (box.scrollHeight - box.clientHeight <= 40) return "It all fits on screen already — nothing to scroll.";

    const before = box.scrollTop;
    box.scrollTo({ top: clamped, behavior: "smooth" });
    settleScroll(box, clamped);

    toolMessage(`scroll_page → ${to}`);
    if (clamped === 0) return "At the top.";
    if (clamped >= box.scrollHeight - box.clientHeight - 4) return "At the bottom.";
    return `Scrolled ${to}.`;
  } catch (err) {
    return errorMessage("scroll_page", describeErr(err));
  }
}

async function handleUndo(raw: unknown): Promise<unknown> {
  const parsed = parseParams(UndoParams, raw);
  if (!parsed.ok) return errorMessage("undo", parsed.error);

  const previous = useLoom.getState().undo();
  if (!previous) return "Nothing to undo — this is the first thing on the canvas.";
  toolMessage("undo");
  return `Undone. Back to ${previous.components.map((c) => c.type).join(", ")}.`;
}

async function handleClearCanvas(raw: unknown): Promise<unknown> {
  const parsed = parseParams(ClearCanvasParams, raw);
  if (!parsed.ok) return errorMessage("clear_canvas", parsed.error);

  const ok = useLoom.getState().clearCanvas();
  if (!ok) return "The canvas is already empty.";
  toolMessage("clear_canvas");
  return "Cleared. Say undo to bring it back.";
}

async function handleHighlightRows(raw: unknown): Promise<unknown> {
  const parsed = parseParams(HighlightRowsParams, raw);
  if (!parsed.ok) return errorMessage("highlight_rows", parsed.error);
  const { componentId, filters } = parsed.data;

  const ok = useLoom.getState().patchComponent(componentId, { highlights: filters });
  if (!ok) return errorMessage("highlight_rows", `no component with id ${componentId}`);

  if (!filters.length) {
    toolMessage(`highlight_rows → ${componentId} (cleared)`);
    return "Highlighting cleared.";
  }

  // Report the count so the agent can say a number the user can verify on screen.
  const state = useLoom.getState();
  const component = state.spec?.components.find((c) => c.id === componentId);
  const datasetId = component && "datasetId" in component ? component.datasetId : undefined;
  const records = datasetId ? (state.datasets[datasetId]?.records ?? []) : [];
  const matched = records.filter((row) => filters.some((f) => applyFilters([row], [f]).length === 1)).length;

  toolMessage(`highlight_rows → ${componentId} (${matched} matched)`);
  return matched === 0 ? "Nothing matched — no rows highlighted." : `Highlighted ${matched} rows.`;
}

async function handleExportData(raw: unknown): Promise<unknown> {
  const parsed = parseParams(ExportDataParams, raw);
  if (!parsed.ok) return errorMessage("export_data", parsed.error);
  const { datasetId, componentId } = parsed.data;

  const state = useLoom.getState();
  const dataset = state.datasets[datasetId];
  if (!dataset) {
    const known = Object.keys(state.datasets);
    return errorMessage(
      "export_data",
      `unknown datasetId ${datasetId}. ` + (known.length ? `Use one of: ${known.join(", ")}` : "Nothing to export yet."),
    );
  }

  try {
    // Export what the user can actually see. Downloading 500 rows when the table
    // shows 12 filtered ones is not what "export this" means.
    const component = componentId ? state.spec?.components.find((c) => c.id === componentId) : undefined;
    const filters = component && "filters" in component ? component.filters : [];
    const rows = applyFilters(dataset.records, filters);
    const fields = dataset.fields.filter((f) => f.key !== "_source");

    const escape = (v: unknown) => {
      const text = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [
      fields.map((f) => escape(f.label)).join(","),
      ...rows.map((row) => fields.map((f) => escape(row[f.key])).join(",")),
    ].join("\n");

    const name = `${dataset.question.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "loom-export"}.csv`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);

    toolMessage(`export_data → ${name} (${rows.length} rows)`);
    return `Downloaded ${rows.length} rows as ${name}${filters.length ? " — the filtered rows only" : ""}.`;
  } catch (err) {
    return errorMessage("export_data", describeErr(err));
  }
}

async function handleSortTable(raw: unknown): Promise<unknown> {
  const parsed = parseParams(SortTableParams, raw);
  if (!parsed.ok) return errorMessage("sort_table", parsed.error);
  const { componentId, field, dir } = parsed.data;

  const ok = useLoom.getState().patchComponent(componentId, { sort: { field, dir } });
  if (!ok) return errorMessage("sort_table", `no component with id ${componentId}`);
  toolMessage(`sort_table → ${componentId} by ${field} ${dir}`);
  return `Sorted by ${field}, ${dir === "asc" ? "smallest" : "largest"} first.`;
}

async function handleMockData(raw: unknown): Promise<unknown> {
  const parsed = parseParams(MockDataParams, raw);
  if (!parsed.ok) return errorMessage("mock_data", parsed.error);
  const { table, rows, mode = "replace" } = parsed.data;

  toolMessage(`mock_data → ${table}${rows ? ` (${rows} rows)` : ""}`);
  const store = useLoom.getState();
  store.setStatus("researching");
  store.setProgress({ label: `Generating ${table}`, done: 0, total: 1 });

  try {
    const dataset = RESEARCH_TABLES.has(table)
      ? await loadResearchDataset(table)
      : await loadGeneratedTable(table, rows);
    const datasetId = dataset.id;

    store.addDataset(dataset);
    const spec = mountDataset(dataset, mode === "add");
    store.setProgress(null);
    store.setStatus("ready");
    toolMessage(`${mode === "add" ? "added to report" : "auto-rendered"} → ${spec.components.map((c) => c.type).join(", ")}`);

    return {
      datasetId,
      question: dataset.question,
      rowCount: dataset.records.length,
      sourceCount: dataset.sources.length,
      columns: dataset.fields.map((f) => `${f.key} (${f.type})`),
      keyFindings: dataset.findings.slice(0, 3).map((f) => f.text),
      rendered: spec.components.map((c) => c.type),
      mode,
      note: RESEARCH_TABLES.has(table)
        ? "A researched dashboard is on screen already. Do NOT call render_ui. Say one " +
          "short sentence about what it shows."
        : "Sample data is on screen already. Do NOT call render_ui. Say one short " +
          "sentence, and make clear this is sample data rather than research.",
    };
  } catch (err) {
    store.setProgress(null);
    store.setStatus(store.spec ? "ready" : "idle");
    return errorMessage("mock_data", describeErr(err));
  }
}

/**
 * Put a dataset on the canvas, either on its own or alongside what is already there.
 *
 * Loading a second dataset used to replace the whole canvas, so "add a table of X
 * too" silently threw away the first one — the user asked for a combined report and
 * got only the last table. When adding, the new dataset contributes a compact set
 * (its numbers and its rows) rather than another five cards, and every id is suffixed
 * so two tables can coexist and be addressed separately.
 */
function mountDataset(dataset: Dataset, append: boolean) {
  const store = useLoom.getState();
  const existing = store.spec;

  if (!append || !existing) {
    const spec = defaultLayout(dataset);
    store.setSpec(spec);
    return spec;
  }

  const suffix = `__${dataset.id.replace(/^ds_/, "")}`;
  const addition = buildLayout(dataset, ["stat_cards", "comparison_table"], undefined, suffix);
  const room = 10 - existing.components.length;

  if (room <= 0) {
    // Nothing sensible to drop on the user's behalf — say so rather than silently
    // truncating a report they are still building.
    return existing;
  }

  const merged = {
    ...existing,
    title: existing.title === dataset.question ? existing.title : "Combined report",
    components: [...existing.components, ...addition.components.slice(0, room)],
  };
  store.setSpec(merged);
  return merged;
}

/**
 * The three pre-researched datasets. These carry real figures compiled from real
 * pages, so they are labelled as research rather than as sample data — the mock
 * framing exists to keep invented numbers out, not to disown genuine ones.
 */
const RESEARCH_TABLES = new Set(["llm_pricing", "dubai_rent", "gpu_cloud"]);

interface ResearchPayload {
  question: string;
  description: string;
  sources: Array<{ id: string; url: string; title: string }>;
  fields: Dataset["fields"];
  records: Dataset["records"];
  findings: Dataset["findings"];
}

/**
 * `fetch` has no timeout of its own — a dev server that hung (or a laptop that went
 * to sleep mid-demo) would leave `handleMockData` awaiting forever, which is worse
 * than a thrown error: the voice turn never resolves at all, so the agent just goes
 * silent with no way to recover. Abort and turn that into a short, catchable error
 * instead.
 */
const MOCK_FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url: string, timeoutMs = MOCK_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s — is the dev server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function loadResearchDataset(table: string): Promise<Dataset> {
  const res = await fetchWithTimeout(`/api/mock/research/${table}`);
  if (!res.ok) throw new Error(`research fixture ${table} returned ${res.status}`);
  const payload = (await res.json()) as ResearchPayload;
  const fetchedAt = new Date().toISOString();

  return {
    id: `ds_${table}`,
    question: payload.question,
    headline: `${payload.records.length} rows across ${payload.sources.length} sources`,
    createdAt: fetchedAt,
    sources: payload.sources.map((s) => ({ ...s, fetchedAt })),
    fields: payload.fields,
    records: payload.records,
    findings: payload.findings,
  };
}

async function loadGeneratedTable(table: string, rows?: number): Promise<Dataset> {
  const url = `/api/mock/${table}${rows ? `?rows=${rows}` : ""}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`mock API returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const sourceId = `src_mock_${table}`;
  const { fields, records } = csvToTable(await res.text(), sourceId);

  return {
    id: `ds_mock_${table}`,
    question: `Sample data: ${table}`,
    // Labelled everywhere it surfaces. Nobody should be able to mistake a generated
    // dashboard for a research result, on stage or in a screenshot.
    headline: `${records.length} generated rows — sample data, not researched`,
    createdAt: new Date().toISOString(),
    sources: [
      {
        id: sourceId,
        url: new URL(url, location.origin).toString(),
        title: `Mock table: ${table} (generated locally)`,
        fetchedAt: new Date().toISOString(),
      },
    ],
    fields,
    records,
    findings: describeTable(table, records.length, fields.length),
  };
}

/** Mechanical notes about the shape of a generated table — never invented insight. */
function describeTable(table: string, rowCount: number, columnCount: number) {
  return [
    { text: `Generated sample table "${table}" — ${rowCount} rows, ${columnCount} columns.`, sourceIds: [] },
    { text: "This data is synthetic. It is here to exercise the interface, not to inform a decision.", sourceIds: [] },
  ];
}

async function handleRenderUi(raw: unknown): Promise<unknown> {
  const parsed = parseParams(RenderUiParams, raw);
  if (!parsed.ok) return errorMessage("render_ui", parsed.error);
  const { datasetId, components, title } = parsed.data;

  const datasets = useLoom.getState().datasets;
  const dataset = datasets[datasetId];
  if (!dataset) {
    const known = Object.keys(datasets);
    return errorMessage(
      "render_ui",
      `unknown datasetId ${datasetId}. ` +
        (known.length ? `Use one of: ${known.join(", ")}` : "No dataset exists yet — call research first."),
    );
  }

  const spec = buildLayout(dataset, components, title);
  useLoom.getState().setSpec(spec);

  const shown = spec.components.map((c) => c.type);
  const dropped = components.filter((k) => !shown.includes(k));
  toolMessage(`render_ui → ${shown.join(", ")}`);

  // Tell the agent what it actually got. A chart needs a numeric column and something
  // to group by; asking for one over data that has neither drops it silently otherwise.
  return dropped.length
    ? `Showing ${shown.join(", ")}. Could not build ${dropped.join(", ")} from this data.`
    : `Showing ${shown.join(", ")}.`;
}

async function handleUpdateComponent(raw: unknown): Promise<unknown> {
  const parsed = parseParams(UpdateComponentParams, raw);
  if (!parsed.ok) return errorMessage("update_component", parsed.error);
  const { id, patch } = parsed.data;

  const existing = useLoom.getState().spec?.components.find((c) => c.id === id);
  if (!existing) return errorMessage("update_component", `no component with id ${id}`);

  // An empty patch used to be applied happily and reported as success, so the agent
  // announced "it's a pie chart now" over an unchanged bar chart. Say what is missing.
  const keys = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (keys.length === 0) {
    return errorMessage(
      "update_component",
      `patch was empty — say what to change, e.g. { "kind": "pie" } for a chart or ` +
        `{ "title": "…" } for any component`,
    );
  }

  // `patchComponent` merges into the live spec unchecked and reports success
  // regardless of what came out the other side. A patch that replaces a chart's `y`
  // with something that is not an array would silently "succeed" here and then throw
  // inside the Canvas on the next render — and there is no error boundary above it,
  // so that is a blank screen on stage. Validate the merged result before applying.
  const merged = { ...existing, ...Object.fromEntries(keys) };
  const check = UiComponentSpec.safeParse(merged);
  if (!check.success) {
    const issue = check.error.issues[0];
    return errorMessage(
      "update_component",
      `that patch would leave an invalid ${existing.type}` +
        (issue ? ` — ${formatPath(issue.path)} ${issue.message}` : ""),
    );
  }

  const ok = useLoom.getState().patchComponent(id, patch);
  if (!ok) return errorMessage("update_component", `no component with id ${id}`);
  toolMessage(`update_component → ${id} (${Object.keys(patch).join(", ")})`);
  return `Updated ${id}`;
}

async function handleSetFilter(raw: unknown): Promise<unknown> {
  const parsed = parseParams(SetFilterParams, raw);
  if (!parsed.ok) return errorMessage("set_filter", parsed.error);
  const { componentId, filters } = parsed.data;

  const ok = useLoom.getState().setFilter(componentId, filters);
  if (!ok) return errorMessage("set_filter", `no filterable component with id ${componentId}`);

  const state = useLoom.getState().getUiState();
  const comp = state.components.find((c) => c.id === componentId);
  const rows = comp?.visibleRows;
  toolMessage(`set_filter → ${componentId} (${filters.length} filter${filters.length === 1 ? "" : "s"})`);
  return rows === undefined ? `Filter applied to ${componentId}` : `Filter applied — ${rows} row${rows === 1 ? "" : "s"} visible`;
}

async function handleFocusComponent(raw: unknown): Promise<unknown> {
  const parsed = parseParams(FocusComponentParams, raw);
  if (!parsed.ok) return errorMessage("focus_component", parsed.error);
  const { id } = parsed.data;

  const ok = useLoom.getState().focusComponent(id);
  if (!ok) return errorMessage("focus_component", `no component with id ${id}`);
  toolMessage(`focus_component → ${id}`);
  return `Focused ${id}`;
}

async function handleGetUiState(raw: unknown): Promise<unknown> {
  const parsed = parseParams(GetUiStateParams, raw);
  if (!parsed.ok) return errorMessage("get_ui_state", parsed.error);

  const state = useLoom.getState().getUiState();
  toolMessage(`get_ui_state → ${state.components.length} component${state.components.length === 1 ? "" : "s"}`);
  return state;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function createToolHandlers(): Record<string, (params: any) => Promise<any>> {
  const handlers = {
    research: handleResearch,
    deepen: handleDeepen,
    read_source: handleReadSource,
    render_ui: handleRenderUi,
    update_component: handleUpdateComponent,
    set_filter: handleSetFilter,
    focus_component: handleFocusComponent,
    mock_data: handleMockData,
    sort_table: handleSortTable,
    add_component: handleAddComponent,
    remove_component: handleRemoveComponent,
    move_component: handleMoveComponent,
    scroll_component: handleScrollComponent,
    scroll_page: handleScrollPage,
    undo: handleUndo,
    clear_canvas: handleClearCanvas,
    export_data: handleExportData,
    highlight_rows: handleHighlightRows,
    get_ui_state: handleGetUiState,
  } satisfies Record<ToolName, (params: any) => Promise<any>>;

  // Belt-and-braces: every key in TOOLS must have a handler, and vice versa. The
  // `satisfies` above already guarantees this at compile time; this just keeps it
  // true even if TOOLS grows without anyone re-reading this file.
  for (const name of Object.keys(TOOLS)) {
    if (!(name in handlers)) {
      console.warn(`[toolHandlers] no handler registered for tool "${name}"`);
    }
  }

  return handlers;
}
