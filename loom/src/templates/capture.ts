import {
  assertNoDataBindings,
  ReportTemplate,
  TEMPLATE_LIMITS,
  TEMPLATE_VERSION,
  type TemplateSlot,
  type UiSpec,
} from "../contract/index.js";

/**
 * Turn the report on screen into a reusable recipe.
 *
 * Capture is a *stripping* operation, not a copy. Everything that ties the live spec
 * to this subject — dataset ids, field keys, chart axes, filters, table columns,
 * findings text — is dropped, and only placement and data-independent presentation
 * survive. That is the entire reason a template saved from a pricing comparison can
 * be selected for a restaurant report.
 *
 * `assertNoDataBindings` runs on the result before it is returned, so a future field
 * added to a slot cannot quietly reintroduce a binding.
 */

function slotId(kind: string, index: number): string {
  return `${kind}_${index + 1}`;
}

export class TemplateCaptureError extends Error {}

export function captureTemplate(spec: UiSpec | null, name: string): ReportTemplate {
  const trimmed = name.trim();
  if (!trimmed) throw new TemplateCaptureError("give the template a name");
  if (trimmed.length > TEMPLATE_LIMITS.maxNameLength) {
    throw new TemplateCaptureError(`names are limited to ${TEMPLATE_LIMITS.maxNameLength} characters`);
  }
  if (!spec || spec.components.length === 0) {
    throw new TemplateCaptureError("there is no report on screen to save");
  }

  const slots: TemplateSlot[] = spec.components.slice(0, TEMPLATE_LIMITS.maxSlots).map((component, index) => {
    const slot: TemplateSlot = {
      slotId: slotId(component.type, index),
      kind: component.type,
      order: index,
    };
    if (component.columnSpan) slot.columnSpan = component.columnSpan;

    // Titles are NOT captured. The app derives them from the data — a chart titled
    // "Price by vendor" names two field labels, which is exactly the domain leak
    // that stops a pricing layout working for restaurants. `buildComponent`
    // regenerates an appropriate title for whatever dataset the template is applied
    // to. (`slot.title` stays in the schema for user-authored labels later.)

    if (component.type === "chart") {
      // Chart kind and legend visibility are presentation. The axes are field keys,
      // so `xTitle`/`yTitle` and `x`/`y` stay out — they name this subject's columns.
      slot.options = {
        chartKind: component.kind,
        ...(component.legend ? { legend: component.legend } : {}),
      };
    }
    if (component.type === "comparison_table") {
      // How many columns, never which ones — column *keys* are the single most
      // domain-specific thing in a report.
      slot.options = { maxColumns: Math.min(12, Math.max(1, component.columns.length)) };
    }
    return slot;
  });

  const now = new Date().toISOString();
  const template = {
    version: TEMPLATE_VERSION,
    id: `tpl_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`,
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    columns: 12,
    slots,
  };

  // Belt and braces: validate the shape, then prove nothing data-bound survived.
  const parsed = ReportTemplate.parse(template);
  assertNoDataBindings(parsed);
  return parsed;
}
