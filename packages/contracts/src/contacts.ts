import { z } from "zod";
import { connectorAccountIdSchema } from "./index";

const contactEmailSchema = z
  .string()
  .min(1)
  .max(320)
  .regex(
    /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
    "Contact email is invalid",
  );

export const contactSchema = z
  .object({
    id: z.string().min(1).max(1_024),
    name: z.string().min(1).max(512),
    emails: z.array(contactEmailSchema).max(8),
  })
  .strict();

export type Contact = z.infer<typeof contactSchema>;

export const contactsSearchInputSchema = z
  .object({
    accountId: connectorAccountIdSchema.optional(),
    query: z.string().min(1).max(200).optional(),
    maxResults: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export type ContactsSearchInput = z.input<typeof contactsSearchInputSchema>;

export const contactsSearchOutputSchema = z
  .object({
    contacts: z.array(contactSchema),
  })
  .strict();

export type ContactsSearchOutput = z.infer<typeof contactsSearchOutputSchema>;
