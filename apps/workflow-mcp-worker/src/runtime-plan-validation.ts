import * as z from 'zod/v4';
import type { RuntimePlan } from './runtime-plan.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
const capability = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/);
const secretRef = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const literal = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const expression: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('literal'), value: literal }).strict(),
    z.object({ kind: z.literal('ref'), path: z.array(identifier).min(1).max(32) }).strict(),
    z.object({ kind: z.literal('call'), name: z.enum(['success', 'failure', 'always']) }).strict(),
    z.object({ kind: z.literal('unary'), op: z.literal('not'), expr: expression }).strict(),
    z.object({
      kind: z.literal('binary'),
      op: z.enum(['and', 'or', '==', '!=', '>', '>=', '<', '<=']),
      left: expression,
      right: expression
    }).strict()
  ])
);

const value: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    literal,
    z.array(value),
    z.record(z.string(), value).refine(object => !Object.hasOwn(object, '$expr')),
    z.object({ $expr: expression }).strict()
  ])
);
const trigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z.object({ type: z.literal('webhook'), id: identifier, secret: secretRef }).strict(),
  z.object({
    type: z.literal('schedule'), id: identifier, cron: z.string().min(1).max(128),
    timezone: z.string().min(1).max(128), misfire: z.literal('latest')
  }).strict()
]);

/** Workers-safe structural validation of the shared immutable v1 compiler IR. */
const planSchema = z.object({
  dslVersion: z.literal(1),
  id: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  inputs: z.record(identifier, z.object({
    type: z.enum(['string', 'number', 'boolean']),
    required: z.boolean(),
    enum: z.array(z.string()).min(1).max(100).optional()
  }).strict()),
  triggers: z.array(trigger).max(32),
  steps: z.record(identifier, z.object({
    uses: capability,
    executor: z.enum(['cloudflare', 'github']),
    needs: z.array(identifier).max(64),
    if: expression.optional(),
    with: z.record(z.string(), value),
    timeoutMs: z.number().int().positive().optional(),
    retryMaxAttempts: z.number().int().min(1).max(10).optional()
  }).strict()),
  outputs: z.record(identifier, value)
}).strict().superRefine((plan, context) => {
  const names = new Set(Object.keys(plan.steps));
  if (names.size === 0 || names.size > 64) {
    context.addIssue({ code: 'custom', message: 'Invalid workflow step count.' });
  }
  for (const [step, entry] of Object.entries(plan.steps)) {
    for (const dependency of entry.needs) {
      if (!names.has(dependency) || dependency === step) {
        context.addIssue({ code: 'custom', message: 'Invalid workflow step dependency.' });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (step: string): void => {
    if (visited.has(step)) return;
    if (visiting.has(step)) {
      context.addIssue({ code: 'custom', message: 'Normalized workflow DAG contains a cycle.' });
      return;
    }
    visiting.add(step);
    for (const dependency of plan.steps[step]?.needs ?? []) {
      if (names.has(dependency)) visit(dependency);
    }
    visiting.delete(step);
    visited.add(step);
  };
  for (const step of names) visit(step);
});

/** Validate external/stored plans without parsing YAML or importing node:crypto. */
export function validateVersionedWorkflowPlan(plan: unknown): RuntimePlan {
  const result = planSchema.safeParse(plan);
  if (!result.success) throw new Error('Invalid or unsupported normalized workflow plan.');
  return result.data as unknown as RuntimePlan;
}
