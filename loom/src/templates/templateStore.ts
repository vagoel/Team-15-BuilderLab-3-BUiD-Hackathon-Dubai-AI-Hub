import { create } from "zustand";
import type { ReportTemplate, UiSpec } from "../contract/index.js";
import { captureTemplate } from "./capture.js";
import { loadSelectedId, loadTemplates, saveSelectedId, saveTemplates } from "./storage.js";

/**
 * Template list and selection.
 *
 * Deliberately separate from the main Loom store: templates outlive a conversation
 * (they are the only thing here that persists across reloads) and nothing in the
 * research or canvas path should be able to mutate them by accident.
 *
 * The one subtle rule is `pinnedTemplate`. A session must render through the exact
 * template the agent was told about at startup — if the user could swap templates
 * mid-conversation, the agent's instructions and the renderer would disagree and
 * neither would be wrong. So `pinTemplate` freezes a snapshot at session start and
 * the UI locks selection until disconnect.
 */

interface TemplateState {
  templates: ReportTemplate[];
  selectedId: string | null;
  /** The snapshot the live session was started with; null when disconnected. */
  pinnedTemplate: ReportTemplate | null;

  selected: () => ReportTemplate | null;
  /** What the renderer must use: the pinned snapshot if a session is live. */
  active: () => ReportTemplate | null;

  saveCurrentReport: (spec: UiSpec | null, name: string) => ReportTemplate;
  select: (id: string | null) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  pinTemplate: () => ReportTemplate | null;
  unpinTemplate: () => void;
}

export const useTemplates = create<TemplateState>((set, get) => ({
  templates: loadTemplates(),
  selectedId: loadSelectedId(),
  pinnedTemplate: null,

  selected: () => {
    const { templates, selectedId } = get();
    return templates.find((t) => t.id === selectedId) ?? null;
  },

  active: () => get().pinnedTemplate ?? get().selected(),

  saveCurrentReport: (spec, name) => {
    const template = captureTemplate(spec, name);
    // Same name twice is almost always a re-save of the same layout, so replace it
    // rather than silently accumulating "Report", "Report", "Report".
    const rest = get().templates.filter((t) => t.name.toLowerCase() !== template.name.toLowerCase());
    const templates = [template, ...rest];
    set({ templates });
    saveTemplates(templates);
    return template;
  },

  select: (id) => {
    // A session pins its template at startup; changing the selection now would
    // desync what the agent was told from what the canvas renders.
    if (get().pinnedTemplate) return;
    set({ selectedId: id });
    saveSelectedId(id);
  },

  rename: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const templates = get().templates.map((t) =>
      t.id === id ? { ...t, name: trimmed, updatedAt: new Date().toISOString() } : t,
    );
    set({ templates });
    saveTemplates(templates);
  },

  remove: (id) => {
    const templates = get().templates.filter((t) => t.id !== id);
    set({ templates });
    saveTemplates(templates);
    if (get().selectedId === id) {
      set({ selectedId: null });
      saveSelectedId(null);
    }
  },

  pinTemplate: () => {
    const template = get().selected();
    set({ pinnedTemplate: template });
    return template;
  },

  unpinTemplate: () => set({ pinnedTemplate: null }),
}));

/** Non-hook read for tool handlers, which run outside React. */
export function activeTemplate(): ReportTemplate | null {
  return useTemplates.getState().active();
}
