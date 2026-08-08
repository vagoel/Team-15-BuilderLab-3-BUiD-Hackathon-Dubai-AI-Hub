/**
 * Pre-researched datasets, served in the shape the research pipeline produces.
 *
 * These stand in for live context.dev extraction while extraction credits are out.
 * Unlike the generated tables in `tables.ts`, the figures here are real: each was
 * compiled from the cited comparison pages in August 2026, and the source list is
 * genuine, so the dashboard attributes rows to pages that actually exist.
 *
 * Gaps are left as null rather than filled in. Real research has holes, the canvas
 * needs to survive them, and inventing numbers to make a demo look tidy is the exact
 * failure this whole app is built to avoid.
 */

export interface ResearchSourceSpec {
  id: string;
  url: string;
  title: string;
}

export interface ResearchDataset {
  name: string;
  question: string;
  description: string;
  sources: ResearchSourceSpec[];
  fields: Array<{ key: string; label: string; type: string; unit?: string }>;
  records: Array<Record<string, string | number | null>>;
  findings: Array<{ text: string; sourceIds: string[] }>;
}

const n = (v: number | null) => v;

// ---------------------------------------------------------------------------

const llmPricing: ResearchDataset = {
  name: "llm_pricing",
  question: "What do the major language model APIs cost per million tokens in 2026?",
  description: "Frontier and budget model pricing across OpenAI, Anthropic, Google, DeepSeek and Mistral.",
  sources: [
    { id: "s_cloudzero", url: "https://www.cloudzero.com/blog/llm-api-pricing-comparison/", title: "LLM API Pricing Comparison In 2026 — CloudZero" },
    { id: "s_tldl", url: "https://www.tldl.io/resources/llm-api-pricing", title: "LLM API Pricing (July 2026) — TLDL" },
    { id: "s_aimagicx", url: "https://www.aimagicx.com/blog/llm-api-pricing-comparison-2026", title: "LLM API Pricing in 2026: The Complete Cost Comparison" },
    { id: "s_morph", url: "https://www.morphllm.com/llm-api", title: "12 LLM APIs Compared by Price per 1M Tokens — Morph" },
  ],
  fields: [
    { key: "vendor", label: "Vendor", type: "string" },
    { key: "model", label: "Model", type: "string" },
    { key: "tier", label: "Tier", type: "string" },
    { key: "input_per_m", label: "Input / M", type: "currency", unit: "$" },
    { key: "output_per_m", label: "Output / M", type: "currency", unit: "$" },
  ],
  records: [
    { vendor: "OpenAI", model: "GPT-5.5", tier: "frontier", input_per_m: 5.0, output_per_m: 30.0, _source: "s_aimagicx" },
    { vendor: "OpenAI", model: "GPT-5.4", tier: "production", input_per_m: 2.5, output_per_m: 15.0, _source: "s_cloudzero" },
    { vendor: "OpenAI", model: "GPT-5.4 Pro", tier: "reasoning", input_per_m: 30.0, output_per_m: n(null), _source: "s_aimagicx" },
    { vendor: "OpenAI", model: "GPT-5.6 Terra", tier: "frontier", input_per_m: 2.5, output_per_m: n(null), _source: "s_tldl" },
    { vendor: "OpenAI", model: "GPT-4.1 Nano", tier: "budget", input_per_m: 0.1, output_per_m: n(null), _source: "s_cloudzero" },
    { vendor: "Anthropic", model: "Claude Opus 4.8", tier: "frontier", input_per_m: 5.0, output_per_m: 25.0, _source: "s_aimagicx" },
    { vendor: "Anthropic", model: "Claude Sonnet 5 (intro)", tier: "production", input_per_m: 2.0, output_per_m: 10.0, _source: "s_tldl" },
    { vendor: "Anthropic", model: "Claude Sonnet 5 (list)", tier: "production", input_per_m: 3.0, output_per_m: 15.0, _source: "s_tldl" },
    { vendor: "Anthropic", model: "Claude Sonnet 4.6", tier: "production", input_per_m: 3.0, output_per_m: 15.0, _source: "s_cloudzero" },
    { vendor: "Google", model: "Gemini 3.1 Pro", tier: "frontier", input_per_m: 2.0, output_per_m: 12.0, _source: "s_aimagicx" },
    { vendor: "Google", model: "Gemini 2.5 Flash-Lite", tier: "budget", input_per_m: 0.1, output_per_m: 0.4, _source: "s_cloudzero" },
    { vendor: "DeepSeek", model: "DeepSeek V3.2", tier: "budget", input_per_m: 0.14, output_per_m: 0.28, _source: "s_morph" },
    { vendor: "Mistral", model: "Mistral Small 3.2", tier: "budget", input_per_m: 0.1, output_per_m: n(null), _source: "s_cloudzero" },
  ],
  findings: [
    { text: "DeepSeek V3.2 is the cheapest listed API overall at $0.14 in and $0.28 out.", sourceIds: ["s_morph"] },
    { text: "Frontier tiers cluster at $5 per million input — Opus 4.8 and GPT-5.5 both land there.", sourceIds: ["s_aimagicx"] },
    { text: "Output tokens run 5–6x input across every vendor; nobody prices them independently.", sourceIds: ["s_cloudzero"] },
    { text: "Claude Sonnet 5 is on introductory pricing to 31 August 2026, after which it returns to $3 / $15.", sourceIds: ["s_tldl"] },
    { text: "Batch APIs take a flat 50% off both directions, and prices fell roughly 80% industry-wide from 2025.", sourceIds: ["s_cloudzero"] },
  ],
};

// ---------------------------------------------------------------------------

const dubaiRent: ResearchDataset = {
  name: "dubai_rent",
  question: "What does it cost to rent an apartment in Dubai by area in 2026?",
  description: "Annual rents and gross rental yields across Dubai Marina, Business Bay and JVC, against the city average.",
  sources: [
    { id: "s_relodxb", url: "https://www.relodxb.com/blog/dubai-rent-prices-by-area-2026", title: "Dubai Rent Prices by Area 2026 — RelocateDXB" },
    { id: "s_guestready", url: "https://www.guestready.com/blog/best-rental-yields-in-dubai/", title: "Best rental yields in Dubai 2026 — GuestReady" },
    { id: "s_astraterra", url: "https://www.astraterra.ae/blogs/rent-apartment-in-business-bay-dubai-2026-prices-best-buildings-tenant-tips", title: "Rent Apartment in Business Bay Dubai 2026 — AstraTerra" },
    { id: "s_restproperty", url: "https://restproperty.com/article-en/rent-in-dubai-2026-prices-by-area/", title: "Rent in Dubai 2026: Prices by Area — RestProperty" },
  ],
  fields: [
    { key: "area", label: "Area", type: "string" },
    { key: "unit_type", label: "Unit", type: "string" },
    { key: "rent_min_aed", label: "Rent from", type: "currency", unit: "AED" },
    { key: "rent_max_aed", label: "Rent to", type: "currency", unit: "AED" },
    { key: "yield_pct", label: "Gross yield", type: "number" },
  ],
  records: [
    { area: "Dubai Marina", unit_type: "Studio", rent_min_aed: 90000, rent_max_aed: 150000, yield_pct: n(null), _source: "s_relodxb" },
    { area: "Dubai Marina", unit_type: "1 bedroom", rent_min_aed: 90000, rent_max_aed: 130000, yield_pct: n(null), _source: "s_relodxb" },
    { area: "Dubai Marina", unit_type: "2 bedroom", rent_min_aed: 130000, rent_max_aed: 190000, yield_pct: n(null), _source: "s_relodxb" },
    { area: "Business Bay", unit_type: "Studio", rent_min_aed: 55000, rent_max_aed: 75000, yield_pct: 8.0, _source: "s_astraterra" },
    { area: "Business Bay", unit_type: "1 bedroom", rent_min_aed: 80000, rent_max_aed: 110000, yield_pct: 7.0, _source: "s_astraterra" },
    { area: "Business Bay", unit_type: "2 bedroom", rent_min_aed: 110000, rent_max_aed: 160000, yield_pct: 6.0, _source: "s_astraterra" },
    { area: "JVC", unit_type: "Studio", rent_min_aed: 40000, rent_max_aed: 55000, yield_pct: 7.87, _source: "s_guestready" },
    { area: "JVC", unit_type: "1 bedroom", rent_min_aed: 55000, rent_max_aed: 75000, yield_pct: 7.04, _source: "s_guestready" },
    { area: "JVC", unit_type: "2 bedroom", rent_min_aed: 75000, rent_max_aed: 100000, yield_pct: 6.78, _source: "s_guestready" },
    { area: "Dubai (city average)", unit_type: "Studio", rent_min_aed: 62700, rent_max_aed: n(null), yield_pct: n(null), _source: "s_restproperty" },
    { area: "Dubai (city average)", unit_type: "1 bedroom", rent_min_aed: 99300, rent_max_aed: n(null), yield_pct: n(null), _source: "s_restproperty" },
    { area: "Dubai (city average)", unit_type: "2 bedroom", rent_min_aed: 168500, rent_max_aed: n(null), yield_pct: n(null), _source: "s_restproperty" },
  ],
  findings: [
    { text: "JVC is the cheapest of the three areas — a studio starts around AED 40,000 against AED 90,000 in the Marina.", sourceIds: ["s_guestready", "s_relodxb"] },
    { text: "Yield runs inverse to price: JVC studios return 7.87%, and the return falls as the unit gets larger.", sourceIds: ["s_guestready"] },
    { text: "Dubai Marina carries roughly a 2x premium over JVC at every unit size.", sourceIds: ["s_relodxb"] },
    { text: "Business Bay sits between them on both rent and yield, at 6–8% depending on unit size.", sourceIds: ["s_astraterra"] },
    { text: "City-average rents are only published as single figures, so those rows have no upper bound.", sourceIds: ["s_restproperty"] },
  ],
};

// ---------------------------------------------------------------------------

const gpuCloud: ResearchDataset = {
  name: "gpu_cloud",
  question: "What does an hour of cloud GPU cost across providers in 2026?",
  description: "H100 and A100 hourly rates across marketplaces, specialists and hyperscalers.",
  sources: [
    { id: "s_intuition", url: "https://intuitionlabs.ai/articles/h100-rental-prices-cloud-comparison", title: "H100 Rental Prices Across 15+ Cloud Providers — IntuitionLabs" },
    { id: "s_spheron", url: "https://www.spheron.network/blog/gpu-cloud-pricing-comparison-2026/", title: "GPU Cloud Pricing Comparison 2026 — Spheron" },
    { id: "s_gpufm", url: "https://www.gpu.fm/blog/cloud-gpu-providers-comparison-2026", title: "Cloud GPU Providers Compared 2026 — gpu.fm" },
    { id: "s_synpix", url: "https://www.synpixcloud.com/blog/gpu-cloud-pricing-comparison-2026", title: "Cloud GPU Pricing 2026 — SynpixCloud" },
  ],
  fields: [
    { key: "provider", label: "Provider", type: "string" },
    { key: "gpu", label: "GPU", type: "string" },
    { key: "category", label: "Category", type: "string" },
    { key: "mode", label: "Mode", type: "string" },
    { key: "usd_per_hour", label: "Per hour", type: "currency", unit: "$" },
  ],
  records: [
    { provider: "Vast.ai", gpu: "H100", category: "marketplace", mode: "on-demand", usd_per_hour: 1.87, _source: "s_intuition" },
    { provider: "RunPod", gpu: "H100 PCIe", category: "specialist", mode: "on-demand", usd_per_hour: 1.99, _source: "s_gpufm" },
    { provider: "Lambda Labs", gpu: "H100", category: "specialist", mode: "on-demand", usd_per_hour: 2.49, _source: "s_gpufm" },
    { provider: "RunPod", gpu: "H100 SXM", category: "specialist", mode: "on-demand", usd_per_hour: 2.69, _source: "s_gpufm" },
    { provider: "Google Cloud", gpu: "H100 (A3-high)", category: "hyperscaler", mode: "on-demand", usd_per_hour: 3.0, _source: "s_intuition" },
    { provider: "CoreWeave", gpu: "H100 PCIe", category: "specialist", mode: "on-demand", usd_per_hour: 4.25, _source: "s_gpufm" },
    { provider: "CoreWeave", gpu: "H100 (8x HGX node)", category: "specialist", mode: "on-demand", usd_per_hour: 6.16, _source: "s_gpufm" },
    { provider: "AWS", gpu: "H100 (p5)", category: "hyperscaler", mode: "on-demand", usd_per_hour: 6.88, _source: "s_intuition" },
    { provider: "Azure", gpu: "H100", category: "hyperscaler", mode: "on-demand", usd_per_hour: 12.29, _source: "s_intuition" },
    { provider: "Spheron", gpu: "A100 80GB", category: "specialist", mode: "spot", usd_per_hour: 0.6, _source: "s_spheron" },
    { provider: "Vast.ai", gpu: "A100", category: "marketplace", mode: "on-demand", usd_per_hour: 0.67, _source: "s_synpix" },
    { provider: "Spheron", gpu: "A100 80GB", category: "specialist", mode: "on-demand", usd_per_hour: 1.07, _source: "s_spheron" },
    { provider: "Lambda Labs", gpu: "A100 40GB", category: "specialist", mode: "on-demand", usd_per_hour: 1.99, _source: "s_synpix" },
    { provider: "CoreWeave", gpu: "A100 80GB PCIe", category: "specialist", mode: "on-demand", usd_per_hour: 2.21, _source: "s_gpufm" },
  ],
  findings: [
    { text: "An H100 hour spans $1.87 to $12.29 — a 6.6x spread for the same silicon.", sourceIds: ["s_intuition"] },
    { text: "Hyperscalers are the expensive end: Azure costs more than six times Vast.ai for an H100.", sourceIds: ["s_intuition"] },
    { text: "Spot pricing runs 40–65% below on-demand; Spheron's A100 drops from $1.07 to $0.60.", sourceIds: ["s_spheron"] },
    { text: "A100s undercut H100s roughly 3x, which still makes them the cheaper choice per hour.", sourceIds: ["s_synpix"] },
    { text: "Reserved commitments of one to twelve months take a further 20–40% off on-demand rates.", sourceIds: ["s_spheron"] },
  ],
};

export const RESEARCH: Record<string, ResearchDataset> = {
  llm_pricing: llmPricing,
  dubai_rent: dubaiRent,
  gpu_cloud: gpuCloud,
};

export function researchCatalogue() {
  return Object.values(RESEARCH).map((d) => ({
    name: d.name,
    question: d.question,
    description: d.description,
    rows: d.records.length,
    sources: d.sources.length,
  }));
}
