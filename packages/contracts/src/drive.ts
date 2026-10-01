import { z } from "zod";
import { connectorAccountIdSchema } from "./index";

export const DRIVE_ITEM_ID_PATTERN = /^[A-Za-z0-9._~!=-]+$/;
export const MAX_DRIVE_TEXT_CHARS = 8_000;

export const driveFileSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(256).optional(),
  })
  .strict();

export type DriveFile = z.infer<typeof driveFileSchema>;

export const driveSearchInputSchema = z
  .object({
    accountId: connectorAccountIdSchema.optional(),
    query: z.string().min(1).max(200),
    maxResults: z.number().int().min(1).max(25).optional(),
  })
  .strict();

export type DriveSearchInput = z.input<typeof driveSearchInputSchema>;

export const driveSearchOutputSchema = z
  .object({
    files: z.array(driveFileSchema),
  })
  .strict();

export type DriveSearchOutput = z.infer<typeof driveSearchOutputSchema>;

export const driveReadInputSchema = z
  .object({
    accountId: connectorAccountIdSchema.optional(),
    id: z
      .string()
      .min(1)
      .max(256)
      .regex(DRIVE_ITEM_ID_PATTERN, "Drive item id is invalid"),
  })
  .strict();

export type DriveReadInput = z.input<typeof driveReadInputSchema>;

export const driveReadOutputSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(256).optional(),
    text: z.string().max(MAX_DRIVE_TEXT_CHARS).optional(),
  })
  .strict();

export type DriveReadOutput = z.infer<typeof driveReadOutputSchema>;
