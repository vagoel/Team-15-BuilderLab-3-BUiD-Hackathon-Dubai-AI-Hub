/**
 * Public API for the research engine. Other agents import ONLY from this file —
 * context.ts, cache.ts, and the internals of pipeline.ts are not part of the
 * contract and may change shape without notice.
 */

export type { ResearchHooks } from "./pipeline.js";
export { deepenResearch, getDataset, readSource, runResearch } from "./pipeline.js";

export { prewarm } from "./cache.js";

export { ContextApiError } from "./context.js";
