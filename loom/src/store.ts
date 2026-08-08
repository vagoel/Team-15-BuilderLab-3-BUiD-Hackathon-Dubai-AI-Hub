import { create } from "zustand";
import type {
  ComponentSize,
  Dataset,
  Filter,
  LayoutKind,
  UiComponentSpec,
  UiSpec,
  UiState,
} from "./contract/index.js";
import { applyFilters } from "./lib/filter.js";

/**
 * React state is the single source of truth (PLAN.md §6).
 *
 * The agent only ever mutates through these actions and only ever reads back through
 * `getUiState`. Nothing else writes to the canvas, so the voice and the screen cannot
 * drift apart.
 */

export type ChatRole = "user" | "agent" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Set on tool-activity lines so the chat can render them differently. */
  kind?: "speech" | "tool" | "status";
  at: number;
}

export interface Progress {
  label: string;
  done: number;
  total: number;
}

export type Status = "idle" | "connecting" | "listening" | "researching" | "ready" | "error";

/** How many dashboards back you can step. Deep enough for a demo, shallow enough
 * that nobody is scrolling through a session's worth of state. */
const HISTORY_LIMIT = 20;

interface LoomState {
  spec: UiSpec | null;
  /** Previous specs, newest last. Voice misrecognition is constant, so "undo that"
   * is the most-reached-for command in any speech interface. */
  history: UiSpec[];
  datasets: Record<string, Dataset>;
  messages: ChatMessage[];
  status: Status;
  progress: Progress | null;
  focusedId: string | null;
  error: string | null;

  setSpec: (spec: UiSpec) => void;
  undo: () => UiSpec | null;
  clearCanvas: () => boolean;
  patchComponent: (id: string, patch: Record<string, unknown>) => boolean;
  addComponent: (component: UiComponentSpec, position?: number) => boolean;
  removeComponent: (id: string) => boolean;
  moveComponent: (id: string, position: number) => boolean;
  setFilter: (componentId: string, filters: Filter[]) => boolean;
  setLayout: (layout: LayoutKind) => boolean;
  resizeComponent: (id: string, size: ComponentSize) => boolean;
  reorderComponents: (ids: string[]) => boolean;
  focusComponent: (id: string) => boolean;
  getUiState: () => UiState;

  addDataset: (dataset: Dataset) => void;
  upsertDataset: (id: string, partial: Partial<Dataset>) => void;

  addMessage: (m: Omit<ChatMessage, "id" | "at">) => void;
  setStatus: (s: Status) => void;
  setProgress: (p: Progress | null) => void;
  setError: (e: string | null) => void;
  reset: () => void;
}

let seq = 0;
const nextId = () => `m${++seq}`;

export const useLoom = create<LoomState>((set, get) => ({
  spec: null,
  history: [],
  datasets: {},
  messages: [],
  status: "idle",
  progress: null,
  focusedId: null,
  error: null,

  setSpec: (spec) =>
    set((s) => ({
      spec,
      history: s.spec ? [...s.history, s.spec].slice(-HISTORY_LIMIT) : s.history,
      status: "ready",
    })),

  undo: () => {
    const { history } = get();
    const previous = history[history.length - 1];
    if (!previous) return null;
    set({ spec: previous, history: history.slice(0, -1), status: "ready" });
    return previous;
  },

  clearCanvas: () => {
    const spec = get().spec;
    if (!spec) return false;
    set({ spec: null, history: [...get().history, spec].slice(-HISTORY_LIMIT), status: "idle" });
    return true;
  },

  patchComponent: (id, patch) => {
    const spec = get().spec;
    if (!spec) return false;
    let hit = false;
    const components = spec.components.map((c) => {
      if (c.id !== id) return c;
      hit = true;
      return { ...c, ...patch } as UiComponentSpec;
    });
    if (hit) {
      set((s) => ({
        spec: { ...spec, components },
        history: [...s.history, spec].slice(-HISTORY_LIMIT),
      }));
    }
    return hit;
  },

  addComponent: (component, position) => {
    const spec = get().spec;
    // Nothing to add to yet, and no dataset context to invent one from.
    if (!spec) return false;
    if (spec.components.some((c) => c.id === component.id)) return false;
    if (spec.components.length >= 10) return false;

    const components = [...spec.components];
    const at = position === undefined ? components.length : clamp(position, 0, components.length);
    components.splice(at, 0, component);
    set((s) => ({ spec: { ...spec, components }, history: [...s.history, spec].slice(-HISTORY_LIMIT) }));
    return true;
  },

  removeComponent: (id) => {
    const spec = get().spec;
    if (!spec) return false;
    const components = spec.components.filter((c) => c.id !== id);
    // Removing the last component would leave an empty canvas that looks like a crash.
    if (components.length === spec.components.length || components.length === 0) return false;
    set((s) => ({ spec: { ...spec, components }, history: [...s.history, spec].slice(-HISTORY_LIMIT) }));
    return true;
  },

  moveComponent: (id, position) => {
    const spec = get().spec;
    if (!spec) return false;
    const from = spec.components.findIndex((c) => c.id === id);
    if (from === -1) return false;

    const components = [...spec.components];
    const [moved] = components.splice(from, 1);
    if (!moved) return false;
    components.splice(clamp(position, 0, components.length), 0, moved);
    set((s) => ({ spec: { ...spec, components }, history: [...s.history, spec].slice(-HISTORY_LIMIT) }));
    return true;
  },

  setFilter: (componentId, filters) => {
    const spec = get().spec;
    if (!spec) return false;
    let hit = false;
    const components = spec.components.map((c) => {
      if (c.id !== componentId) return c;
      if (c.type !== "comparison_table" && c.type !== "chart") return c;
      hit = true;
      return { ...c, filters };
    });
    if (hit) {
      set((s) => ({
        spec: { ...spec, components },
        history: [...s.history, spec].slice(-HISTORY_LIMIT),
      }));
    }
    return hit;
  },

  setLayout: (layout) => {
    const spec = get().spec;
    if (!spec || spec.layout === layout) return spec?.layout === layout;
    set((s) => ({
      spec: { ...spec, layout },
      history: [...s.history, spec].slice(-HISTORY_LIMIT),
    }));
    return true;
  },

  resizeComponent: (id, size) => {
    const spec = get().spec;
    if (!spec) return false;
    let hit = false;
    const components = spec.components.map((c) => {
      if (c.id !== id) return c;
      hit = true;
      // Merge so a width-only voice command doesn't wipe a height the user dragged.
      return { ...c, size: { ...c.size, ...size } };
    });
    if (hit) {
      set((s) => ({
        spec: { ...spec, components },
        history: [...s.history, spec].slice(-HISTORY_LIMIT),
      }));
    }
    return hit;
  },

  /**
   * Reorder to match `ids` (a drag-to-move gesture, sorted by where the cards
   * landed). Components missing from `ids` keep their spot at the end; a no-op
   * order writes no history entry, so an aborted drag costs nothing to undo.
   */
  reorderComponents: (ids) => {
    const spec = get().spec;
    if (!spec) return false;
    const rank = new Map(ids.map((id, i) => [id, i]));
    const components = [...spec.components].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    if (components.every((c, i) => c.id === spec.components[i]?.id)) return true;
    set((s) => ({
      spec: { ...spec, components },
      history: [...s.history, spec].slice(-HISTORY_LIMIT),
    }));
    return true;
  },

  focusComponent: (id) => {
    const exists = get().spec?.components.some((c) => c.id === id) ?? false;
    if (exists) {
      set({ focusedId: id });
      setTimeout(() => {
        if (get().focusedId === id) set({ focusedId: null });
      }, 2400);
    }
    return exists;
  },

  getUiState: () => {
    const { spec, datasets } = get();
    if (!spec) return { components: [] };
    return {
      title: spec.title,
      layout: spec.layout,
      components: spec.components.map((c) => {
        const datasetId = "datasetId" in c ? c.datasetId : undefined;
        const filters = "filters" in c ? c.filters : undefined;
        const records = datasetId ? (datasets[datasetId]?.records ?? []) : [];
        // Only row-bearing components report a row count. A source list reporting
        // "120 visible rows" invites the agent to say something untrue about it.
        const hasRows = c.type === "comparison_table" || c.type === "chart";
        return {
          id: c.id,
          type: c.type,
          title: c.title,
          datasetId,
          filters,
          visibleRows: hasRows && datasetId ? applyFilters(records, filters ?? []).length : undefined,
          size: c.size,
        };
      }),
    };
  },

  addDataset: (dataset) => set((s) => ({ datasets: { ...s.datasets, [dataset.id]: dataset } })),

  upsertDataset: (id, partial) =>
    set((s) => {
      const existing = s.datasets[id];
      const merged = { ...(existing ?? emptyDataset(id)), ...partial } as Dataset;
      return { datasets: { ...s.datasets, [id]: merged } };
    }),

  addMessage: (m) =>
    set((s) => ({ messages: [...s.messages, { ...m, id: nextId(), at: Date.now() }] })),

  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error, status: error ? "error" : "idle" }),
  reset: () =>
    set({ spec: null, history: [], datasets: {}, messages: [], progress: null, error: null, status: "idle" }),
}));

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function emptyDataset(id: string): Dataset {
  return {
    id,
    question: "",
    headline: "",
    createdAt: new Date().toISOString(),
    sources: [],
    fields: [],
    records: [],
    findings: [],
  };
}
