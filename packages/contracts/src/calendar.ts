import { z } from "zod";
import { connectorAccountIdSchema } from "./index";

export const calendarEventSchema = z
  .object({
    id: z.string().min(1).max(1_024),
    title: z.string().min(1).max(512),
    start: z.string().min(1).max(80),
    end: z.string().min(1).max(80),
    location: z.string().min(1).max(512).optional(),
  })
  .strict();

export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const calendarListInputSchema = z
  .object({
    accountId: connectorAccountIdSchema.optional(),
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
    maxResults: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export type CalendarListInput = z.input<typeof calendarListInputSchema>;

export const calendarListOutputSchema = z
  .object({
    events: z.array(calendarEventSchema),
  })
  .strict();

export type CalendarListOutput = z.infer<typeof calendarListOutputSchema>;

export const calendarCreateInputSchema = z
  .object({
    accountId: connectorAccountIdSchema.optional(),
    title: z.string().min(1).max(256),
    start: z.string().datetime(),
    end: z.string().datetime(),
    location: z.string().min(1).max(512).optional(),
    body: z.string().min(1).max(8_000).optional(),
  })
  .strict();

export type CalendarCreateInput = z.input<typeof calendarCreateInputSchema>;

export const calendarCreateOutputSchema = z
  .object({
    id: z.string().min(1).max(1_024),
    title: z.string().min(1).max(512),
    start: z.string().min(1).max(80),
    end: z.string().min(1).max(80),
  })
  .strict();

export type CalendarCreateOutput = z.infer<typeof calendarCreateOutputSchema>;
