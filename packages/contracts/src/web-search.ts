import { z } from "zod";

export const webSearchHitSchema = z
  .object({
    title: z.string().min(1),
    url: z.string().url(),
    snippet: z.string(),
  })
  .strict();

export type WebSearchHit = z.infer<typeof webSearchHitSchema>;

export const webSearchInputSchema = z
  .object({
    query: z.string().min(1).max(2_000),
    maxResults: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export type WebSearchInput = z.input<typeof webSearchInputSchema>;

export const webSearchOutputSchema = z
  .object({
    query: z.string(),
    hits: z.array(webSearchHitSchema),
  })
  .strict();

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

export const searchProviderStatusSchema = z
  .object({
    hasKey: z.boolean(),
    enabled: z.boolean(),
    connected: z.boolean(),
  })
  .strict();

export type SearchProviderStatus = z.infer<typeof searchProviderStatusSchema>;
