import { z } from "zod";
import { ComponentKind, Filter } from "./ui.js";

/**
 * The single source of truth for every tool the agent can call.
 *
 * Every tool currently runs in the browser: there is no backend yet, so the research
 * tools reach context.dev through the Vite dev proxy (which holds the key). The
 * `kind` field is kept because moving `research` back behind a server is a one-line
 * change here plus a webhook URL — nothing else in the app knows the difference.
 *
 * The server imports this to validate incoming calls. The agent-config generator
 * imports it to declare the tools to ElevenLabs. Because both read the same object,
 * a tool name or parameter cannot drift between the two sides.
 */

export type ToolKind = "server" | "client";

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  kind: ToolKind;
  description: string;
  params: S;
  /** Client tools only: whether the agent should block on the return value. */
  waitForResponse?: boolean;
  /** Spoken while the tool runs, so there is never dead air. */
  preToolSpeech?: string;
}

const def = <S extends z.ZodType>(d: ToolDef<S>) => d;

// ---------------------------------------------------------------------------
// Server tools — the agent's eyes on the live web.
// ---------------------------------------------------------------------------

export const ResearchParams = z.object({
  question: z.string().describe("The research question, in full, as the user asked it."),
  seedUrls: z
    .array(z.string())
    .min(1)
    .max(8)
    .describe("The pages to read. Pick real, specific URLs likely to carry the answer."),
  fields: z
    .array(
      z.object({
        key: z.string().describe("snake_case identifier, e.g. price_aed"),
        label: z.string(),
        type: z.enum(["string", "number", "currency", "date", "url"]),
        unit: z.string().optional().describe("Currency code when type is currency, e.g. AED"),
      }),
    )
    .min(2)
    .max(8)
    .describe(
      "The columns you want extracted from every page. You are designing the schema — " +
        "choose fields that make the answer comparable across sources.",
    ),
});

export const DeepenParams = z.object({
  datasetId: z.string(),
  angle: z.string().describe("The follow-up angle to research, e.g. 'add Business Bay'."),
});

export const ReadSourceParams = z.object({
  sourceId: z.string(),
});

// ---------------------------------------------------------------------------
// Client tools — the agent's hands on the page.
// ---------------------------------------------------------------------------

/**
 * Deliberately flat.
 *
 * This used to take a whole `UiSpec`. ElevenLabs' schema subset cannot express the
 * five-way component union, so the model only ever saw an untyped object — it guessed
 * the shape, guessed wrong, and looped on the same invalid spec no matter how much
 * documentation we handed back. Explaining the union harder did not work.
 *
 * So the model picks intent and the app picks presentation: name the components you
 * want, in order, and the layout is derived from the dataset. There is nothing here
 * to get wrong — one id and a list of five known words.
 */
export const RenderUiParams = z.object({
  datasetId: z.string().describe("The datasetId that research returned."),
  components: z
    .array(ComponentKind)
    .describe(
      "Which components to show, in order. Choose from: stat_cards, chart, " +
        "comparison_table, findings, source_list. A good default for a comparison is " +
        "stat_cards, chart, comparison_table, source_list.",
    ),
  title: z.string().optional().describe("Heading for the dashboard."),
});

/**
 * `patch` used to be a free-form record. Zod turns that into a bare
 * `{"type":"object"}` with no properties, so the model was never told what could go
 * inside it — it sent `{}`, the handler cheerfully applied nothing, and the agent
 * announced "it's a pie chart now" over an unchanged bar chart. Naming the settable
 * keys is the fix; every one of them is a shape ElevenLabs can actually express.
 */
export const UpdateComponentParams = z.object({
  id: z.string().describe("Component id, e.g. auto_chart or auto_table."),
  patch: z
    .object({
      kind: z
        .enum(["bar", "line", "pie"])
        .optional()
        .describe("Chart type. This is how you turn a bar chart into a pie."),
      title: z.string().optional().describe("New heading for the component."),
      x: z.string().optional().describe("Chart only: the field key to group by."),
      y: z.array(z.string()).optional().describe("Chart only: the numeric field keys to plot."),
      columns: z.array(z.string()).optional().describe("Table only: which columns to show."),
    })
    .describe("What to change. Set only the keys you are changing, e.g. { kind: 'pie' }."),
});

export const SetFilterParams = z.object({
  componentId: z.string(),
  filters: z.array(Filter).describe("Replaces the component's filters. Empty array clears them."),
});

export const FocusComponentParams = z.object({
  id: z.string(),
});

export const GetUiStateParams = z.object({});

/**
 * Mock mode. Loads a generated table from the local mock API instead of researching
 * the live web — same parse-and-render pipeline, fake data source.
 *
 * It earns its place: extraction credits are finite, and being able to put a
 * hundred-row table on screen in under a second is how you demonstrate or debug the
 * canvas without spending one.
 */
export const AddComponentParams = z.object({
  datasetId: z.string().describe("Which dataset the new component should read from."),
  type: ComponentKind.describe("stat_cards, chart, comparison_table, findings or source_list."),
  position: z
    .number()
    .optional()
    .describe("Zero-based slot to insert at. Omit to append at the end."),
});

export const RemoveComponentParams = z.object({
  id: z.string().describe("Component id, e.g. auto_chart."),
});

export const MoveComponentParams = z.object({
  id: z.string().describe("Component id to move."),
  position: z.number().describe("Zero-based slot to move it to. 0 puts it first."),
});

export const ScrollComponentParams = z.object({
  id: z.string().describe("Component id, usually auto_table."),
  to: z
    .enum(["top", "bottom", "down", "up"])
    .describe("top and bottom jump to the ends; down and up move by roughly one screenful."),
  amount: z
    .number()
    .optional()
    .describe("Screenfuls to move for up/down. Defaults to 1. Ignored for top/bottom."),
});

export const ScrollPageParams = z.object({
  to: z
    .enum(["top", "bottom", "down", "up"])
    .describe("Where to move the whole page. down and up move by about one screenful."),
});

export const UndoParams = z.object({});
export const ClearCanvasParams = z.object({});

export const ExportDataParams = z.object({
  datasetId: z.string().describe("Which dataset to download."),
  componentId: z
    .string()
    .optional()
    .describe("A table id, to export only the rows its filters currently leave visible."),
});

export const HighlightRowsParams = z.object({
  componentId: z.string().describe("Usually auto_table."),
  filters: z
    .array(Filter)
    .describe(
      "Rows matching ANY of these are marked. An empty array clears the highlighting. " +
        "Use this rather than set_filter when the user wants to see which rows match " +
        "while keeping the rest on screen.",
    ),
});

export const SortTableParams = z.object({
  componentId: z.string().describe("Usually auto_table."),
  field: z.string().describe("A field key from the dataset."),
  dir: z.enum(["asc", "desc"]).describe("asc for smallest first, desc for largest first."),
});

export const MockDataParams = z.object({
  table: z
    .enum([
      "llm_pricing",
      "dubai_rent",
      "gpu_cloud",
      "sales",
      "employees",
      "models",
      "weather",
      "market_share",
      "numbers",
    ])
    .describe(
      "The first three are REAL pre-researched datasets with genuine sources — prefer " +
        "these whenever the topic fits. llm_pricing: language model API costs per million " +
        "tokens across OpenAI, Anthropic, Google, DeepSeek, Mistral. dubai_rent: Dubai " +
        "apartment rents and yields by area. gpu_cloud: H100 and A100 hourly rates by " +
        "provider. The rest are generated filler for testing the interface: sales, " +
        "employees, models, weather, market_share (small, good for a pie), numbers.",
    ),
  rows: z
    .number()
    .optional()
    .describe("How many rows to generate, up to 1000. Omit for the table's natural size."),
  mode: z
    .enum(["replace", "add"])
    .optional()
    .describe(
      "replace (the default) clears the canvas and shows this table on its own. " +
        "Use add when the user wants this alongside what is already there — " +
        "'add a table of X too', 'combine these into one report'.",
    ),
});

export const TOOLS = {
  research: def({
    name: "research",
    kind: "client",
    description:
      "Read the live web to answer a research question. Returns a dataset id plus a short " +
      "summary — never the full data. Follow this with render_ui to show the results.",
    params: ResearchParams,
    preToolSpeech: "Let me go and read up on that.",
  }),

  deepen: def({
    name: "deepen",
    kind: "client",
    description:
      "Extend an existing dataset with an additional angle, reusing what was already read.",
    params: DeepenParams,
    preToolSpeech: "Adding that in now.",
  }),

  read_source: def({
    name: "read_source",
    kind: "client",
    description: "Fetch the full clean text of one source so you can quote or summarise it.",
    params: ReadSourceParams,
  }),

  render_ui: def({
    name: "render_ui",
    kind: "client",
    description:
      "Change which components are on the dashboard. A default dashboard is mounted " +
      "automatically when research finishes, so only call this when the user asks for a " +
      "different set of components — for example 'just the table' or 'add a chart'.",
    params: RenderUiParams,
    waitForResponse: true,
  }),

  update_component: def({
    name: "update_component",
    kind: "client",
    description:
      "Change one mounted component in place, for example switching a chart from bar to line.",
    params: UpdateComponentParams,
    waitForResponse: true,
  }),

  set_filter: def({
    name: "set_filter",
    kind: "client",
    description:
      "Filter the rows shown by a table or chart, e.g. only rows under two million.",
    params: SetFilterParams,
    waitForResponse: true,
  }),

  add_component: def({
    name: "add_component",
    kind: "client",
    description:
      "Add one component to the dashboard without rebuilding it — 'add a pie chart', " +
      "'also show the sources'. Prefer this over render_ui, which replaces everything.",
    params: AddComponentParams,
    waitForResponse: true,
  }),

  remove_component: def({
    name: "remove_component",
    kind: "client",
    description: "Take one component off the dashboard — 'drop the chart', 'hide the sources'.",
    params: RemoveComponentParams,
    waitForResponse: true,
  }),

  move_component: def({
    name: "move_component",
    kind: "client",
    description:
      "Reorder the dashboard — 'put the table at the top' is move_component(auto_table, 0).",
    params: MoveComponentParams,
    waitForResponse: true,
  }),

  scroll_page: def({
    name: "scroll_page",
    kind: "client",
    description:
      "Scroll the whole dashboard — 'scroll down', 'back to the top', 'show me the " +
      "bottom'. Use scroll_component instead to scroll inside a long table.",
    params: ScrollPageParams,
    waitForResponse: true,
  }),

  undo: def({
    name: "undo",
    kind: "client",
    description:
      "Undo the last change to the dashboard. Reach for this whenever the user says " +
      "'undo', 'go back', 'never mind', 'that's not what I meant', or corrects a " +
      "command you just carried out.",
    params: UndoParams,
    waitForResponse: true,
  }),

  clear_canvas: def({
    name: "clear_canvas",
    kind: "client",
    description: "Empty the dashboard — 'clear this', 'start over'. Undo can bring it back.",
    params: ClearCanvasParams,
    waitForResponse: true,
  }),

  export_data: def({
    name: "export_data",
    kind: "client",
    description:
      "Download the data as a CSV file — 'export this', 'can I get that as a " +
      "spreadsheet', 'download the table'. Pass a componentId to export only the rows " +
      "currently visible after filtering.",
    params: ExportDataParams,
    waitForResponse: true,
  }),

  highlight_rows: def({
    name: "highlight_rows",
    kind: "client",
    description:
      "Mark rows without hiding the others — 'highlight anything under fifty', 'which " +
      "ones are from Anthropic?'. set_filter removes rows; this keeps the whole table " +
      "on screen and draws the eye, which is usually what someone means when they ask " +
      "which rows match.",
    params: HighlightRowsParams,
    waitForResponse: true,
  }),

  scroll_component: def({
    name: "scroll_component",
    kind: "client",
    description:
      "Scroll WITHIN a component that has its own scrollbar — a long table, say. This is " +
      "what 'scroll down a bit' means when a table is already on screen. Use " +
      "focus_component instead only to bring an off-screen component into view.",
    params: ScrollComponentParams,
    waitForResponse: true,
  }),

  sort_table: def({
    name: "sort_table",
    kind: "client",
    description:
      "Sort a table by one column, e.g. 'sort by price, cheapest first'. The same sort " +
      "state backs the clickable column headers, so voice and clicks stay in agreement.",
    params: SortTableParams,
    waitForResponse: true,
  }),

  focus_component: def({
    name: "focus_component",
    kind: "client",
    description: "Scroll a component into view and highlight it while you talk about it.",
    params: FocusComponentParams,
  }),

  mock_data: def({
    name: "mock_data",
    kind: "client",
    description:
      "Load a generated sample table instead of researching the live web. Use this ONLY " +
      "when the user explicitly asks for mock, sample, test or demo data, or asks to see " +
      "what the interface can do. It renders a dashboard exactly as research does. Never " +
      "use it to answer a real question — say you could not find something rather than " +
      "showing invented data as if it were real.",
    params: MockDataParams,
    preToolSpeech: "Loading a sample table.",
    waitForResponse: true,
  }),

  get_ui_state: def({
    name: "get_ui_state",
    kind: "client",
    description:
      "Read what is currently on the user's screen. Call this before answering questions " +
      "about what they can see, or before changing something you did not just render.",
    params: GetUiStateParams,
    waitForResponse: true,
  }),
} as const satisfies Record<string, ToolDef>;

export type ToolName = keyof typeof TOOLS;

export const SERVER_TOOLS = Object.values(TOOLS).filter((t) => t.kind === "server");
export const CLIENT_TOOLS = Object.values(TOOLS).filter((t) => t.kind === "client");

type JsonSchemaNode = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  [k: string]: unknown;
};

/**
 * ElevenLabs rejects any schema property that carries no description — including
 * deeply nested ones ("Must set one of: description, dynamic_variable, ...").
 * Zod only emits a description where we wrote `.describe()`, so anything we left
 * undocumented would 422 at sync time.
 *
 * Rather than sprinkle boilerplate `.describe()` through every nested field, fill the
 * gaps here from the property's own name. Real descriptions still win; this only
 * covers the fields whose meaning is already obvious from the key.
 */
/**
 * ElevenLabs also accepts only a narrow subset of JSON Schema — `minItems`,
 * `maxItems`, `default` and friends all 422 with "Extra inputs are not permitted".
 * Whitelist the keys they understand and drop the rest. The dropped constraints
 * still hold: the handlers validate against the full zod schema on the way in, so
 * this only relaxes what the *model* is told, never what we accept.
 */
const ALLOWED_KEYS = new Set(["type", "description", "properties", "items", "required", "enum"]);

/**
 * Unwraps the wrappers that don't change what a field *is*, only how zod tracks it —
 * mirrors `unwrapSchema` in `voice/toolHandlers.ts` (kept local rather than shared so
 * this file, which `scripts/sync-agent.ts` and `agentConfig.ts` both import, has no
 * dependency on the voice layer).
 */
function unwrapZod(schema: z.ZodTypeAny | undefined): z.ZodTypeAny | undefined {
  let s = schema;
  for (;;) {
    if (!s) return s;
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

function zodObjectShape(schema: z.ZodTypeAny | undefined): Record<string, z.ZodTypeAny> | undefined {
  const inner = unwrapZod(schema);
  return inner instanceof z.ZodObject ? (inner.shape as Record<string, z.ZodTypeAny>) : undefined;
}

function zodArrayElement(schema: z.ZodTypeAny | undefined): z.ZodTypeAny | undefined {
  const inner = unwrapZod(schema);
  return inner instanceof z.ZodArray ? (inner.element as z.ZodTypeAny) : undefined;
}

function ensureDescriptions(node: JsonSchemaNode, zodSchema?: z.ZodTypeAny, name?: string): JsonSchemaNode {
  const out: JsonSchemaNode = {};

  for (const [key, value] of Object.entries(node)) {
    if (ALLOWED_KEYS.has(key)) out[key] = value;
  }

  // A union has no single `type` they can represent, so it has to collapse to one.
  //
  // Which one matters enormously. `value: string | number` collapsed to "object" once,
  // and the model believed it — it sent `{...}` where a scalar belonged and every
  // set_filter call failed. So: a union of primitives collapses to "string" (our
  // filters already parse numerics out of strings), and only a genuinely
  // object-shaped union falls back to "object".
  if (!out.type) {
    const branches = (node.anyOf ?? node.oneOf) as JsonSchemaNode[] | undefined;
    const allPrimitive =
      Array.isArray(branches) &&
      branches.length > 0 &&
      branches.every((b) => b.type === "string" || b.type === "number" || b.type === "boolean");

    out.type = allPrimitive ? "string" : "object";
    if (!allPrimitive) {
      delete out.properties;
      delete out.required;
    }
  }

  if (name && !out.description) {
    out.description = name.replace(/[_-]/g, " ");
  }

  // `z.toJSONSchema(..., { io: "input" })` derives `required` from each field's
  // *input* type. For a plain field that is correct, but `set_filter`'s `value` is
  // `z.preprocess(fn, z.union([string, number]))` — a preprocess's input type is
  // `unknown` (it has to accept anything the raw tool call sends before the function
  // runs), so the deriver reads that as "undefined is acceptable" and drops `value`
  // out of `required`, even though it has no default and `Filter.parse` rejects a
  // missing `value` outright. That is the exact bug that has already shipped twice on
  // this field, just wearing a new shape. Recompute `required` straight from the zod
  // shape with `isOptional()` (does `safeParse(undefined)` succeed?), which is right
  // regardless of what preprocessing sits in between — it is the same question the
  // handler's own validation ultimately asks.
  const shape = zodObjectShape(zodSchema);
  if (out.properties && shape) {
    out.required = Object.keys(out.properties).filter((key) => shape[key] && !shape[key]!.isOptional());
  }

  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, child]) => [key, ensureDescriptions(child, shape?.[key], key)]),
    );
  }
  if (out.items) {
    out.items = ensureDescriptions(out.items, zodArrayElement(zodSchema), name ? `${name} entry` : "entry");
  }
  return out;
}

/**
 * Render a tool definition in the shape ElevenLabs expects. Used by the agent-config
 * generator and the sync script, so the dashboard and this file can never disagree.
 */
export function toElevenLabsTool(tool: ToolDef, serverBaseUrl?: string) {
  const schema = ensureDescriptions(z.toJSONSchema(tool.params, { io: "input" }) as JsonSchemaNode, tool.params);

  if (tool.kind === "client") {
    return {
      type: "client" as const,
      name: tool.name,
      description: tool.description,
      expects_response: tool.waitForResponse ?? false,
      parameters: schema,
      ...(tool.preToolSpeech ? { pre_tool_speech: tool.preToolSpeech } : {}),
    };
  }

  return {
    type: "webhook" as const,
    name: tool.name,
    description: tool.description,
    api_schema: {
      url: `${serverBaseUrl ?? "{SERVER_URL}"}/tools/${tool.name}`,
      method: "POST" as const,
      request_body_schema: schema,
    },
    ...(tool.preToolSpeech ? { pre_tool_speech: tool.preToolSpeech } : {}),
  };
}
