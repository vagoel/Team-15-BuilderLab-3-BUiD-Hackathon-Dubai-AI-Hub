import { z } from "zod";

/**
 * A dataset is the bulk output of one research run. It never travels through the
 * language model — the model gets an id and a summary, the browser fetches the rest.
 * See PLAN.md §3.
 */

export const FieldType = z.enum(["string", "number", "currency", "date", "url"]);
export type FieldType = z.infer<typeof FieldType>;

export const FieldSpec = z.object({
  key: z.string(),
  label: z.string(),
  type: FieldType,
  /** Currency code when type is "currency", e.g. "AED". */
  unit: z.string().optional(),
});
export type FieldSpec = z.infer<typeof FieldSpec>;

export const Source = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  /** Populated opportunistically from context.dev brand data; absent is fine. */
  brand: z
    .object({
      name: z.string().optional(),
      logoUrl: z.string().optional(),
      color: z.string().optional(),
    })
    .optional(),
  /** Set when the source was read successfully. */
  fetchedAt: z.string().optional(),
  error: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

export const Finding = z.object({
  text: z.string(),
  sourceIds: z.array(z.string()).default([]),
});
export type Finding = z.infer<typeof Finding>;

/** One extracted row. Keys line up with FieldSpec.key. */
export const DataRecord = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export type DataRecord = z.infer<typeof DataRecord>;

/** One scraped image, always carrying the source it was found on. */
export const DatasetImage = z.object({
  src: z.string(),
  alt: z.string().optional(),
  sourceId: z.string(),
});
export type DatasetImage = z.infer<typeof DatasetImage>;

export const Dataset = z.object({
  id: z.string(),
  question: z.string(),
  headline: z.string(),
  createdAt: z.string(),
  sources: z.array(Source),
  fields: z.array(FieldSpec),
  records: z.array(DataRecord),
  findings: z.array(Finding),
  /**
   * Populated only when the agent asked for image retrieval. Optional so every
   * dataset built before image support still parses.
   */
  images: z.array(DatasetImage).optional(),
});
export type Dataset = z.infer<typeof Dataset>;

/**
 * What the agent actually receives back from `research`. Deliberately tiny —
 * roughly 200 tokens regardless of how many rows were pulled.
 */
export const ResearchSummary = z.object({
  datasetId: z.string(),
  headline: z.string(),
  keyFindings: z.array(z.string()),
  sourceCount: z.number(),
  recordCount: z.number(),
  availableFields: z.array(z.object({ key: z.string(), label: z.string(), type: FieldType })),
});
export type ResearchSummary = z.infer<typeof ResearchSummary>;
