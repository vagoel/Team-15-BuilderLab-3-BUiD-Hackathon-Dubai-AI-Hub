import type { Dataset, UiSpec } from "../contract/index.js";
import { useLoom } from "../store.js";

/**
 * Development harness. Seeds the canvas with a realistic dataset and dashboard so
 * the rendering layer can be worked on without a voice session or a live research
 * run. Not shipped anywhere near the demo path — this exists so the 85% of the
 * screen that matters can be built and tested independently of the other two layers.
 */

const SOURCES = [
  { id: "s1", host: "bayut.com", title: "Dubai Marina apartments for sale", color: "#00a3a1" },
  { id: "s2", host: "propertyfinder.ae", title: "JVC 2-bedroom listings", color: "#ef5da8" },
  { id: "s3", host: "dubizzle.com", title: "Business Bay property prices", color: "#e8354e" },
];

const ROWS: Array<[string, number, number, number, string]> = [
  ["Dubai Marina", 2_450_000, 2, 1320, "s1"],
  ["Dubai Marina", 2_150_000, 2, 1180, "s1"],
  ["Dubai Marina", 1_950_000, 2, 1105, "s1"],
  ["Dubai Marina", 3_100_000, 3, 1740, "s1"],
  ["JVC", 1_180_000, 2, 1240, "s2"],
  ["JVC", 1_050_000, 2, 1090, "s2"],
  ["JVC", 1_320_000, 2, 1385, "s2"],
  ["JVC", 890_000, 1, 780, "s2"],
  ["Business Bay", 1_890_000, 2, 1150, "s3"],
  ["Business Bay", 2_240_000, 2, 1290, "s3"],
  ["Business Bay", 1_640_000, 1, 860, "s3"],
  ["Business Bay", 2_980_000, 3, 1620, "s3"],
];

export function seedDataset(): Dataset {
  const records = ROWS.map(([area, price, beds, sqft, source]) => ({
    area,
    price_aed: price,
    beds,
    size_sqft: sqft,
    price_per_sqft: Math.round(price / sqft),
    _source: source,
  }));

  return {
    id: "ds_demo",
    question: "Compare 2-bedroom prices in Dubai Marina, JVC and Business Bay",
    headline: "12 listings across 3 sources, AED 890k–3.1M",
    createdAt: new Date().toISOString(),
    sources: SOURCES.map((s) => ({
      id: s.id,
      url: `https://www.${s.host}/`,
      title: s.title,
      brand: { name: s.host.split(".")[0], color: s.color },
      fetchedAt: new Date().toISOString(),
    })),
    fields: [
      { key: "area", label: "Area", type: "string" },
      { key: "price_aed", label: "Price", type: "currency", unit: "AED" },
      { key: "beds", label: "Beds", type: "number" },
      { key: "size_sqft", label: "Size (sqft)", type: "number" },
      { key: "price_per_sqft", label: "AED / sqft", type: "currency", unit: "AED" },
    ],
    records,
    findings: [
      { text: "JVC is the cheapest of the three, averaging AED 1.1M for a 2-bed.", sourceIds: ["s2"] },
      { text: "Dubai Marina carries a 96% premium over JVC on the same bed count.", sourceIds: ["s1", "s2"] },
      { text: "Business Bay sits between them at roughly AED 1.9M.", sourceIds: ["s3"] },
      { text: "Per square foot, Marina leads at AED 1,780 against JVC's AED 955.", sourceIds: ["s1", "s2"] },
    ],
  };
}

export function seedSpec(): UiSpec {
  return {
    title: "Marina vs JVC vs Business Bay",
    layout: "grid",
    components: [
      {
        id: "stats",
        type: "stat_cards",
        items: [
          { label: "Listings read", value: "12", hint: "across 3 sources" },
          { label: "Median price", value: "AED 1.92M" },
          { label: "Cheapest area", value: "JVC", delta: "−52%" },
          { label: "Dearest per sqft", value: "Marina", delta: "+86%" },
        ],
      },
      {
        id: "chart",
        type: "chart",
        title: "Price by listing",
        datasetId: "ds_demo",
        kind: "bar",
        x: "area",
        y: ["price_aed"],
        filters: [],
      },
      {
        id: "sources",
        type: "source_list",
        title: "Sources",
        datasetId: "ds_demo",
      },
      {
        id: "table",
        type: "comparison_table",
        title: "All listings",
        datasetId: "ds_demo",
        columns: ["area", "beds", "size_sqft", "price_aed", "price_per_sqft"],
        sort: { field: "price_aed", dir: "asc" },
        filters: [],
        highlights: [],
      },
      {
        id: "findings",
        type: "findings",
        title: "What stood out",
        datasetId: "ds_demo",
      },
    ],
  };
}

/** Load the demo dashboard into the store. */
export function loadDemo() {
  const s = useLoom.getState();
  s.addDataset(seedDataset());
  s.setSpec(seedSpec());
}

/** Exercise the filter path the way a voice command would. */
export function demoFilter(maxPrice: number) {
  useLoom
    .getState()
    .setFilter("table", maxPrice > 0 ? [{ field: "price_aed", op: "lt", value: maxPrice }] : []);
  useLoom
    .getState()
    .setFilter("chart", maxPrice > 0 ? [{ field: "price_aed", op: "lt", value: maxPrice }] : []);
}
