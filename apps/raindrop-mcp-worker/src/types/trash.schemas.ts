import { z } from "zod";

const total = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^trash:sha256:[a-f0-9]{64}$/);
export const TrashEmptyInputSchema = z.union([
  z.object({}).strict(),
  z
    .object({
      confirm: z.literal(true),
      collectionId: z.literal(-99),
      expectedTotal: total,
      digest,
    })
    .strict(),
]);
export const TrashEmptyOutputSchema = z.object({
  status: z.enum(["preview", "succeeded", "failed", "unknown", "notExecuted"]),
  collectionId: z.literal(-99),
  total: total.optional(),
  ids: z.array(z.number().int().positive().safe()).optional(),
  digest: digest.optional(),
  reason: z.string(),
});
export type TrashEmptyOutcome = z.infer<typeof TrashEmptyOutputSchema>;
