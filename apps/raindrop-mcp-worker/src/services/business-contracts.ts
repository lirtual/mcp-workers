import { z } from "zod";
import { UpstreamError } from "../types/mcpErrors.js";

export const BusinessId = z.number().int().positive().refine(Number.isSafeInteger, "Expected a positive safe ID");
export const HighlightBusinessSchema = z.object({
  _id: z.string().min(1),
  text: z.string(),
  note: z.string().optional(),
  color: z.string().optional(),
}).passthrough();

// Only fields mandatory for identifying a bookmark are required. Optional
// official fields still need valid types when supplied; extensions pass through.
export const BookmarkBusinessSchema = z.object({
  _id: BusinessId,
  link: z.string().optional(),
  title: z.string().optional(),
  excerpt: z.string().optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  important: z.boolean().optional(),
  type: z.string().optional(),
  created: z.string().optional(),
  lastUpdate: z.string().optional(),
  collection: z.object({ $id: z.number().int().refine(Number.isSafeInteger) }).passthrough().optional(),
  highlights: z.array(HighlightBusinessSchema).optional(),
}).passthrough();

export const CollectionBusinessSchema = z.object({
  _id: BusinessId,
  title: z.string(),
  count: z.number().int().nonnegative().refine(Number.isSafeInteger).nullable().optional(),
  parent: z.object({ $id: z.number().int().refine(Number.isSafeInteger) }).passthrough().nullable().optional(),
}).passthrough();

export const TagBusinessSchema = z.object({
  _id: z.string().min(1),
  count: z.number().int().nonnegative().refine(Number.isSafeInteger),
}).passthrough();

export function requireBusiness<T>(schema: z.ZodTypeAny, value: T, description: string): T {
  if (!schema.safeParse(value).success) {
    throw new UpstreamError(`Invalid upstream ${description} business structure`);
  }
  return value;
}
