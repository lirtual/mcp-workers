import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { getCapabilityDescriptor } from './capabilities.js';
import { hasConnection } from './connections.js';
import { parseCronExpression, validateTimeZone } from './cron.js';
import { compileTimeMcpRetryLimit } from './effective-policy.js';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const CAPABILITY_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const MAX_PLAN_BYTES = 256 * 1024;

const inputDefinitionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    required: z.boolean().optional(),
    enum: z.array(z.string()).min(1).max(100).optional()
  })
  .strict();

const manualTriggerSchema = z.object({ type: z.literal('manual') }).strict();
const webhookTriggerSchema = z
  .object({
    type: z.literal('webhook'),
    id: z.string().regex(IDENTIFIER),
    secret: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)
  })
  .strict();
const scheduleTriggerSchema = z
  .object({
    type: z.literal('schedule'),
    id: z.string().regex(IDENTIFIER),
    cron: z.string().min(1).max(128),
    timezone: z.string().min(1).max(128).optional(),
    misfire: z.literal('latest').optional()
  })
  .strict();

const retrySchema = z.object({ maxAttempts: z.number().int().min(1).max(10) }).strict();

const stepDefinitionSchema = z
  .object({
    uses: z.string().regex(CAPABILITY_NAME),
    needs: z.union([z.string().regex(IDENTIFIER), z.array(z.string().regex(IDENTIFIER)).max(64)]).optional(),
    if: z.string().min(1).max(4096).optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    timeout: z.union([z.number().int().positive(), z.string().min(1).max(32)]).optional(),
    retry: retrySchema.optional()
  })
  .strict();

const workflowDefinitionSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(IDENTIFIER),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    inputs: z.record(z.string().regex(IDENTIFIER), inputDefinitionSchema).optional(),
    triggers: z.array(z.discriminatedUnion('type', [manualTriggerSchema, webhookTriggerSchema, scheduleTriggerSchema])).max(32),
    steps: z.record(z.string().regex(IDENTIFIER), stepDefinitionSchema),
    outputs: z.record(z.string().regex(IDENTIFIER), z.unknown()).optional()
  })
  .strict();

type RawWorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export type ExpressionAst =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'ref'; path: string[] }
  | { kind: 'call'; name: 'success' | 'failure' | 'always' }
  | { kind: 'unary'; op: 'not'; expr: ExpressionAst }
  | {
      kind: 'binary';
      op: 'and' | 'or' | '==' | '!=' | '>' | '>=' | '<' | '<=';
      left: ExpressionAst;
      right: ExpressionAst;
    };

interface Token {
  type: 'identifier' | 'number' | 'string' | 'op' | 'lparen' | 'rparen' | 'dot' | 'eof';
  value: string;
}

export interface CompiledWorkflowEntry {
  sourcePath: string;
  definitionDigest: string;
  metadata: {
    id: string;
    name: string;
    description?: string;
    definitionDigest: string;
    triggerTypes: string[];
    inputs: Record<string, { type: 'string' | 'number' | 'boolean'; required: boolean; enum?: string[] }>;
    stepCapabilities: string[];
  };
  plan: unknown;
}

function fail(message: string): never {
  throw new Error(message);
}

function tokenizeExpression(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const two = source.slice(index, index + 2);
    if (['&&', '||', '==', '!=', '>=', '<='].includes(two)) {
      tokens.push({ type: 'op', value: two });
      index += 2;
      continue;
    }

    if (['>', '<', '!'].includes(char)) {
      tokens.push({ type: 'op', value: char });
      index += 1;
      continue;
    }
    if (char === '(') {
      tokens.push({ type: 'lparen', value: char });
      index += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'rparen', value: char });
      index += 1;
      continue;
    }
    if (char === '.') {
      tokens.push({ type: 'dot', value: char });
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let cursor = index + 1;
      let escaped = false;
      while (cursor < source.length) {
        const current = source[cursor]!;
        if (!escaped && current === quote) break;
        escaped = !escaped && current === '\\';
        if (current !== '\\') escaped = false;
        cursor += 1;
      }
      if (cursor >= source.length) fail('Unterminated string literal in expression.');
      const raw = source.slice(index, cursor + 1);
      const value =
        quote === '"'
          ? (JSON.parse(raw) as string)
          : raw.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      tokens.push({ type: 'string', value });
      index = cursor + 1;
      continue;
    }

    const numberMatch = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?/);
    if (numberMatch) {
      tokens.push({ type: 'number', value: numberMatch[0] });
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
    if (identifierMatch) {
      const value = identifierMatch[0];
      if (value === 'and' || value === 'or' || value === 'not') {
        tokens.push({ type: 'op', value });
      } else {
        tokens.push({ type: 'identifier', value });
      }
      index += value.length;
      continue;
    }

    fail(`Unsupported token in expression near "${source.slice(index, index + 16)}".`);
  }

  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

class ExpressionParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ExpressionAst {
    const expression = this.parseOr();
    if (this.peek().type !== 'eof') fail(`Unexpected token "${this.peek().value}" in expression.`);
    return expression;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private take(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private matchesOperator(...values: string[]): boolean {
    const token = this.peek();
    return token.type === 'op' && values.includes(token.value);
  }

  private parseOr(): ExpressionAst {
    let left = this.parseAnd();
    while (this.matchesOperator('or', '||')) {
      this.take();
      left = { kind: 'binary', op: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): ExpressionAst {
    let left = this.parseComparison();
    while (this.matchesOperator('and', '&&')) {
      this.take();
      left = { kind: 'binary', op: 'and', left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): ExpressionAst {
    let left = this.parseUnary();
    if (this.matchesOperator('==', '!=', '>', '>=', '<', '<=')) {
      const operator = this.take().value as '==' | '!=' | '>' | '>=' | '<' | '<=';
      left = { kind: 'binary', op: operator, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): ExpressionAst {
    if (this.matchesOperator('not', '!')) {
      this.take();
      return { kind: 'unary', op: 'not', expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExpressionAst {
    const token = this.take();

    if (token.type === 'lparen') {
      const expression = this.parseOr();
      if (this.take().type !== 'rparen') fail('Missing closing parenthesis in expression.');
      return expression;
    }

    if (token.type === 'string') return { kind: 'literal', value: token.value };
    if (token.type === 'number') return { kind: 'literal', value: Number(token.value) };

    if (token.type !== 'identifier') fail(`Unexpected token "${token.value}" in expression.`);

    if (token.value === 'true' || token.value === 'false' || token.value === 'null') {
      return {
        kind: 'literal',
        value: token.value === 'null' ? null : token.value === 'true'
      };
    }

    if (this.peek().type === 'lparen') {
      this.take();
      if (this.take().type !== 'rparen') fail('Status predicates do not accept arguments.');
      if (token.value !== 'success' && token.value !== 'failure' && token.value !== 'always') {
        fail(`Unknown expression function "${token.value}".`);
      }
      return { kind: 'call', name: token.value };
    }

    const path = [token.value];
    while (this.peek().type === 'dot') {
      this.take();
      const segment = this.take();
      if (segment.type !== 'identifier') fail('Expression reference contains an invalid path segment.');
      path.push(segment.value);
    }
    return { kind: 'ref', path };
  }
}

export function parseExpression(source: string): ExpressionAst {
  return new ExpressionParser(tokenizeExpression(source)).parse();
}

function collectRefs(expression: ExpressionAst, result: string[][] = []): string[][] {
  if (expression.kind === 'ref') result.push(expression.path);
  if (expression.kind === 'unary') collectRefs(expression.expr, result);
  if (expression.kind === 'binary') {
    collectRefs(expression.left, result);
    collectRefs(expression.right, result);
  }
  return result;
}

function normalizeValue(value: unknown, context: { inputNames: Set<string>; stepNames: Set<string> }): unknown {
  if (typeof value === 'string') {
    const match = value.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
    if (match) {
      const ast = parseExpression(match[1]!);
      validateExpressionRefs(ast, context);
      return { $expr: ast };
    }
    if (value.includes('${{')) fail('Expressions must occupy the entire scalar value in v0.1.');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => normalizeValue(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        normalizeValue(nested, context)
      ])
    );
  }
  return value;
}

function validateExpressionRefs(
  ast: ExpressionAst,
  context: { inputNames: Set<string>; stepNames: Set<string> }
): void {
  for (const path of collectRefs(ast)) {
    if (path[0] === 'input') {
      if (path.length < 2 || !context.inputNames.has(path[1]!)) {
        fail(`Expression references unknown workflow input "${path.slice(1).join('.')} ".`);
      }
      continue;
    }
    if (path[0] === 'trigger') {
      if (path.length < 2) fail('trigger expression references require a field.');
      continue;
    }
    if (path[0] === 'steps') {
      if (path.length < 4 || !context.stepNames.has(path[1]!) || path[2] !== 'outputs') {
        fail(`Invalid step output reference "${path.join('.')}".`);
      }
      continue;
    }
    fail(`Unsupported expression reference root "${path[0]}".`);
  }
}

function normalizeDuration(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) fail(`Invalid duration "${value}".`);
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
  return amount * multiplier;
}

function assertDag(stepNames: string[], dependencies: Map<string, string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (step: string): void => {
    if (visited.has(step)) return;
    if (visiting.has(step)) fail(`Workflow DAG contains a cycle involving "${step}".`);
    visiting.add(step);
    for (const dependency of dependencies.get(step) ?? []) visit(dependency);
    visiting.delete(step);
    visited.add(step);
  };

  for (const step of stepNames) visit(step);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, canonicalize((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function normalizeWorkflow(raw: RawWorkflowDefinition): unknown {
  if (Object.keys(raw.steps).length === 0) fail('Workflow must contain at least one step.');
  if (Object.keys(raw.steps).length > 64) fail('Workflow may contain at most 64 steps.');

  const inputNames = new Set(Object.keys(raw.inputs ?? {}));
  const stepNames = new Set(Object.keys(raw.steps));
  const dependencies = new Map<string, string[]>();
  const normalizedSteps: Record<string, unknown> = {};

  for (const [stepId, step] of Object.entries(raw.steps)) {
    const contract = getCapabilityDescriptor(step.uses);
    if (!contract) fail(`Unknown capability "${step.uses}" in step "${stepId}".`);

    const needs = step.needs === undefined ? [] : typeof step.needs === 'string' ? [step.needs] : step.needs;
    for (const dependency of needs) {
      if (!stepNames.has(dependency)) fail(`Step "${stepId}" depends on unknown step "${dependency}".`);
      if (dependency === stepId) fail(`Step "${stepId}" cannot depend on itself.`);
    }
    dependencies.set(stepId, needs);

    const withValue = step.with ?? {};
    for (const key of Object.keys(withValue)) {
      if (!contract.allowedInputs.has(key as never)) {
        fail(`Step "${stepId}" passes unknown input "${key}" to capability "${step.uses}".`);
      }
    }

    let operationMaxAttempts = contract.maxAutomaticAttempts;
    if (step.uses === 'mcp.call') {
      const connection = withValue.connection;
      const tool = withValue.tool;
      if (typeof connection !== 'string' || !hasConnection(connection)) {
        fail(`Step "${stepId}" must reference a configured static MCP connection.`);
      }
      if (typeof tool !== 'string' || tool.length === 0) {
        fail(`Step "${stepId}" must reference a literal MCP tool name.`);
      }
      operationMaxAttempts = compileTimeMcpRetryLimit(connection, tool);
    }

    const retryMaxAttempts = step.retry?.maxAttempts;
    if (retryMaxAttempts !== undefined && retryMaxAttempts > operationMaxAttempts) {
      fail(`Step "${stepId}" requests ${retryMaxAttempts} attempts but operation "${step.uses}" permits at most ${operationMaxAttempts}.`);
    }

    const expressionContext = { inputNames, stepNames };
    const normalized: Record<string, unknown> = {
      uses: step.uses,
      executor: contract.executor,
      needs,
      with: normalizeValue(withValue, expressionContext)
    };

    if (step.if !== undefined) {
      const ast = parseExpression(
        step.if.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')
      );
      validateExpressionRefs(ast, expressionContext);
      normalized.if = ast;
    }
    const timeoutMs = normalizeDuration(step.timeout);
    if (timeoutMs !== undefined) normalized.timeoutMs = timeoutMs;
    if (retryMaxAttempts !== undefined) normalized.retryMaxAttempts = retryMaxAttempts;

    normalizedSteps[stepId] = normalized;
  }

  assertDag([...stepNames], dependencies);

  const normalizedOutputs: Record<string, unknown> = {};
  for (const [name, output] of Object.entries(raw.outputs ?? {})) {
    normalizedOutputs[name] = normalizeValue(output, { inputNames, stepNames });
  }

  for (const trigger of raw.triggers) {
    if (trigger.type !== 'schedule') continue;
    parseCronExpression(trigger.cron);
    validateTimeZone(trigger.timezone ?? 'UTC');
  }

  const normalizedInputs = Object.fromEntries(
    Object.entries(raw.inputs ?? {}).map(([name, input]) => [
      name,
      {
        type: input.type,
        required: input.required ?? true,
        ...(input.enum ? { enum: input.enum } : {})
      }
    ])
  );

  return {
    dslVersion: 1,
    id: raw.id,
    name: raw.name,
    ...(raw.description ? { description: raw.description } : {}),
    inputs: normalizedInputs,
    triggers: raw.triggers.map(trigger => ({
      ...trigger,
      ...(trigger.type === 'schedule'
        ? { timezone: trigger.timezone ?? 'UTC', misfire: trigger.misfire ?? 'latest' }
        : {})
    })),
    steps: normalizedSteps,
    outputs: normalizedOutputs
  };
}

export function compileWorkflowText(source: string, sourcePath = '<memory>'): CompiledWorkflowEntry {
  const parsed = parseYaml(source);
  const raw = workflowDefinitionSchema.parse(parsed);
  const plan = normalizeWorkflow(raw);
  const serialized = canonicalStringify(plan);
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > MAX_PLAN_BYTES) {
    fail(`Normalized workflow plan is ${size} bytes; maximum is ${MAX_PLAN_BYTES}.`);
  }

  const definitionDigest = createHash('sha256').update(serialized).digest('hex');
  const metadata = {
    id: raw.id,
    name: raw.name,
    ...(raw.description ? { description: raw.description } : {}),
    definitionDigest,
    triggerTypes: raw.triggers.map(trigger => trigger.type),
    inputs: Object.fromEntries(
      Object.entries(raw.inputs ?? {}).map(([name, input]) => [
        name,
        {
          type: input.type,
          required: input.required ?? true,
          ...(input.enum ? { enum: input.enum } : {})
        }
      ])
    ),
    stepCapabilities: [...new Set(Object.values(raw.steps).map(step => step.uses))]
  };

  return { sourcePath, definitionDigest, metadata, plan };
}

export function generateRegistrySource(entries: readonly CompiledWorkflowEntry[]): string {
  const stable = [...entries].sort((left, right) => left.metadata.id.localeCompare(right.metadata.id));
  return [
    '/* This file is generated by scripts/compile-workflows.ts. Do not edit manually. */',
    `export const workflowRegistry = ${JSON.stringify(stable, null, 2)} as const;`,
    ''
  ].join('\n');
}
