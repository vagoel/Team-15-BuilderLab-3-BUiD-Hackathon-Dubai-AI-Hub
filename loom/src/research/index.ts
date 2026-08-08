/**
 * Public API for the research engine. Other agents import ONLY from this file —
 * context.ts, cache.ts, sourceSets.ts, and the internals of pipeline.ts are not part
 * of the contract and may change shape without notice.
 */

export type { ResearchHooks, RunResearchParams } from "./pipeline.js";
export { datasetHasSource, deepenResearch, getDataset, readSource, runResearch } from "./pipeline.js";

export { getSourceSet, registerDirectUrls, resetSourceSets, searchForSources, SourceSetError } from "./sourceSets.js";

export { prewarm } from "./cache.js";

export { ContextApiError, lastCallMetadata } from "./context.js";
