import type { Dataset } from "../contract/index.js";
import { buildLayout } from "../canvas/autoLayout.js";
import { useLoom } from "../store.js";

/**
 * Sample datasets for exercising the canvas without spending a research call.
 *
 * These are synthetic and labelled as such in the UI. They exist because the agent
 * rightly refuses to fabricate data — that is correct behaviour for a research tool,
 * but it leaves no way to see what the components do at scale. Nothing here is
 * reachable from the voice path; it is a dev harness only.
 */

export interface Showcase {
  id: string;
  label: string;
  note: string;
  dataset: Dataset;
}

const now = () => new Date().toISOString();

/** 120 rows of pure arithmetic — the honest way to look at a big table. */
function numbers(): Dataset {
  const records = Array.from({ length: 120 }, (_, i) => {
    const n = i + 1;
    return {
      n,
      square: n * n,
      cube: n * n * n,
      root: Math.round(Math.sqrt(n) * 1000) / 1000,
      parity: n % 2 === 0 ? "even" : "odd",
      _source: "s_math",
    };
  });

  return {
    id: "ds_numbers",
    question: "Numbers 1 to 120, with squares and cubes",
    headline: "120 rows — squares, cubes and roots",
    createdAt: now(),
    sources: [
      {
        id: "s_math",
        url: "https://example.com/generated",
        title: "Generated locally — not researched",
        fetchedAt: now(),
      },
    ],
    fields: [
      { key: "n", label: "n", type: "number" },
      { key: "square", label: "n²", type: "number" },
      { key: "cube", label: "n³", type: "number" },
      { key: "root", label: "√n", type: "number" },
      { key: "parity", label: "Parity", type: "string" },
    ],
    records,
    findings: [
      { text: "120 rows, so the table scrolls inside its own card with a sticky header.", sourceIds: [] },
      { text: "Cubes reach 1,728,000 by n = 120, which is what forces the compact axis labels.", sourceIds: [] },
      { text: "Parity splits the set evenly at 60 each — useful for testing the pie.", sourceIds: [] },
    ],
  };
}

/** 108 rows across 6 vendors — the shape a real deep research run produces. */
function modelPricing(): Dataset {
  const vendors = [
    { id: "s_a", name: "Northwind AI", host: "northwind.example", color: "#5b8cff", base: 3.2 },
    { id: "s_b", name: "Solstice Labs", host: "solstice.example", color: "#00d3a7", base: 1.8 },
    { id: "s_c", name: "Meridian", host: "meridian.example", color: "#ffb454", base: 5.4 },
    { id: "s_d", name: "Harbour Compute", host: "harbour.example", color: "#ff6b6b", base: 0.9 },
    { id: "s_e", name: "Vantage", host: "vantage.example", color: "#a78bfa", base: 2.6 },
    { id: "s_f", name: "Kestrel", host: "kestrel.example", color: "#22d3ee", base: 4.1 },
  ];
  const families = ["nano", "mini", "standard", "pro", "ultra", "reasoning"];
  const contexts = [8, 32, 128];

  const records: Dataset["records"] = [];
  for (const v of vendors) {
    families.forEach((family, fi) => {
      contexts.forEach((ctx, ci) => {
        const multiplier = (fi + 1) * (1 + ci * 0.45);
        const input = Math.round(v.base * multiplier * 100) / 100;
        records.push({
          vendor: v.name,
          model: `${family}-${ctx}k`,
          family,
          context_k: ctx,
          input_per_m: input,
          output_per_m: Math.round(input * 3.1 * 100) / 100,
          latency_ms: 120 + fi * 90 + ci * 40,
          _source: v.id,
        });
      });
    });
  }

  return {
    id: "ds_models",
    question: "Sample: language model pricing across six vendors",
    headline: `${records.length} models across ${vendors.length} vendors, $0.81–$47.30 per M input`,
    createdAt: now(),
    sources: vendors.map((v) => ({
      id: v.id,
      url: `https://${v.host}/pricing`,
      title: `${v.name} — pricing`,
      brand: { name: v.name, color: v.color },
      fetchedAt: now(),
    })),
    fields: [
      { key: "vendor", label: "Vendor", type: "string" },
      { key: "model", label: "Model", type: "string" },
      { key: "family", label: "Family", type: "string" },
      { key: "context_k", label: "Context (k)", type: "number" },
      { key: "input_per_m", label: "Input / M", type: "currency", unit: "$" },
      { key: "output_per_m", label: "Output / M", type: "currency", unit: "$" },
      { key: "latency_ms", label: "Latency", type: "number" },
    ],
    records,
    findings: [
      { text: "Harbour Compute is cheapest at the nano tier; Meridian is dearest across every family.", sourceIds: ["s_d", "s_c"] },
      { text: "Output tokens run about 3.1× input everywhere — nobody prices them independently.", sourceIds: [] },
      { text: "Moving from 8k to 128k context costs roughly 90% more, consistently.", sourceIds: [] },
      { text: "Latency scales with family size far more than with context length.", sourceIds: [] },
    ],
  };
}

/** Few rows, one dominant category — the case a pie is actually good at. */
function marketShare(): Dataset {
  const rows: Array<[string, number, string]> = [
    ["Northwind AI", 34.2, "s_a"],
    ["Solstice Labs", 24.8, "s_b"],
    ["Meridian", 15.1, "s_c"],
    ["Harbour Compute", 11.6, "s_d"],
    ["Vantage", 7.3, "s_e"],
    ["Kestrel", 4.4, "s_f"],
    ["Everyone else", 2.6, "s_g"],
  ];

  return {
    id: "ds_share",
    question: "Sample: inference market share",
    headline: "7 players, top two hold 59%",
    createdAt: now(),
    sources: [
      { id: "s_a", url: "https://example.com/share", title: "Generated locally — not researched", fetchedAt: now() },
    ],
    fields: [
      { key: "vendor", label: "Vendor", type: "string" },
      { key: "share_pct", label: "Share", type: "number" },
    ],
    records: rows.map(([vendor, share, source]) => ({
      vendor,
      share_pct: share,
      _source: source,
    })),
    findings: [
      { text: "The top two vendors hold 59% between them.", sourceIds: [] },
      { text: "The long tail is thin — everything outside the top six is under 3%.", sourceIds: [] },
    ],
  };
}

export const SHOWCASES: Showcase[] = [
  { id: "numbers", label: "Numbers 1–120", note: "120 rows · scrolling table", dataset: numbers() },
  { id: "models", label: "Model pricing", note: "108 rows · 6 sources · charts", dataset: modelPricing() },
  { id: "share", label: "Market share", note: "7 rows · built for the pie", dataset: marketShare() },
];

export function loadShowcase(id: string) {
  const showcase = SHOWCASES.find((s) => s.id === id);
  if (!showcase) return;

  const store = useLoom.getState();
  store.addDataset(showcase.dataset);
  // Go through the same auto-layout the research path uses, so what you see here is
  // exactly what the agent would have produced from a dataset of this shape.
  store.setSpec(buildLayout(showcase.dataset, ["stat_cards", "chart", "comparison_table", "findings", "source_list"]));
}

/** Swap the mounted chart between bar, line and pie. */
export function setChartKind(kind: "bar" | "line" | "pie") {
  useLoom.getState().patchComponent("auto_chart", { kind });
}

/** Point the chart at a different pair of columns. */
export function setChartFields(x: string, y: string) {
  useLoom.getState().patchComponent("auto_chart", { x, y: [y] });
}
