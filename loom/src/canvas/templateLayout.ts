import type { Dataset, ReportTemplate, UiComponentSpec, UiSpec } from "../contract/index.js";
import { buildComponent } from "./autoLayout.js";

/**
 * Apply a saved template to a fresh report.
 *
 * The agent is *told* about the selected template through a dynamic variable, but
 * being told is not enforcement — a model that forgets, or paraphrases, would give
 * the user a layout they did not pick. So the renderer resolves the same pinned
 * template itself. Agent context explains the intent; this code is what makes it
 * true.
 *
 * A slot is a request for a kind of component, not a copy of one: the template holds
 * no dataset ids and no field keys (see contract/template.ts), so each slot is
 * rebuilt against the current dataset by the same `buildComponent` the adaptive path
 * uses. That is what lets a layout saved from a pricing report work on restaurants.
 */

export interface TemplateApplication {
  spec: UiSpec;
  /** Slot kinds this dataset could not support, for an honest tool result. */
  omitted: string[];
}

export function applyTemplate(dataset: Dataset, template: ReportTemplate, title?: string): TemplateApplication {
  const components: UiComponentSpec[] = [];
  const omitted: string[] = [];
  const usedIds = new Set<string>();

  const slots = [...template.slots].sort((a, b) => a.order - b.order);

  for (const slot of slots) {
    const built = buildComponent(dataset, slot.kind);
    if (!built) {
      // A chart needs a numeric column; a gallery needs images. Omitting the slot
      // and saying so beats mounting an empty card that looks like a bug.
      omitted.push(slot.kind);
      continue;
    }

    // Slot ids keep template components addressable and stable across re-renders,
    // and stop two slots of the same kind colliding on `auto_chart`.
    let id = `${built.id}__${slot.slotId}`;
    let n = 2;
    while (usedIds.has(id)) id = `${built.id}__${slot.slotId}_${n++}`;
    usedIds.add(id);

    let component = { ...built, id } as UiComponentSpec;
    if (slot.title) component = { ...component, title: slot.title } as UiComponentSpec;
    if (slot.columnSpan) component = { ...component, columnSpan: slot.columnSpan } as UiComponentSpec;

    // Data-independent presentation options only.
    if (slot.options?.chartKind && component.type === "chart") {
      component = { ...component, kind: slot.options.chartKind };
    }
    if (slot.options?.maxColumns && component.type === "comparison_table") {
      component = { ...component, columns: component.columns.slice(0, slot.options.maxColumns) };
    }

    components.push(component);
    if (components.length >= 10) break;
  }

  // A template every slot of which failed would otherwise render an empty canvas
  // that reads as a crash. Fall back to the one component any dataset supports.
  if (!components.length) {
    components.push({ id: "auto_sources", type: "source_list", title: "Sources", datasetId: dataset.id });
  }

  return {
    spec: {
      title: title ?? dataset.question,
      layout: components.length > 2 ? "grid" : "stack",
      components,
    },
    omitted,
  };
}
