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

export interface RuntimeInputDefinition {
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  enum?: readonly string[];
}

export interface RuntimeStep {
  uses: string;
  executor: 'cloudflare' | 'github';
  needs: readonly string[];
  if?: ExpressionAst;
  with: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  retryMaxAttempts?: number;
}

export interface RuntimePlan {
  dslVersion: 1;
  id: string;
  name: string;
  description?: string;
  inputs: Readonly<Record<string, RuntimeInputDefinition>>;
  triggers: readonly Readonly<Record<string, unknown>>[];
  steps: Readonly<Record<string, RuntimeStep>>;
  outputs: Readonly<Record<string, unknown>>;
}

export function asRuntimePlan(value: unknown): RuntimePlan {
  if (!value || typeof value !== 'object') throw new Error('Pinned workflow plan is invalid.');
  const candidate = value as Partial<RuntimePlan>;
  if (candidate.dslVersion !== 1 || typeof candidate.id !== 'string' || !candidate.steps) {
    throw new Error('Pinned workflow plan uses an unsupported format.');
  }
  return candidate as RuntimePlan;
}

export function resolveRuntimeValue(
  value: unknown,
  context: {
    input: Readonly<Record<string, unknown>>;
    stepOutputs: Readonly<Record<string, unknown>>;
  }
): unknown {
  if (Array.isArray(value)) return value.map(item => resolveRuntimeValue(item, context));

  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    if ('$expr' in objectValue) {
      return evaluateExpression(objectValue.$expr as ExpressionAst, context);
    }
    return Object.fromEntries(
      Object.entries(objectValue).map(([key, nested]) => [key, resolveRuntimeValue(nested, context)])
    );
  }
  return value;
}

function evaluateExpression(
  expression: ExpressionAst,
  context: {
    input: Readonly<Record<string, unknown>>;
    stepOutputs: Readonly<Record<string, unknown>>;
  }
): unknown {
  if (expression.kind === 'literal') return expression.value;
  if (expression.kind === 'call') {
    if (expression.name === 'success') return true;
    if (expression.name === 'failure') return false;
    return true;
  }
  if (expression.kind === 'ref') {
    if (expression.path[0] === 'input') {
      return getPath(context.input, expression.path.slice(1));
    }
    if (expression.path[0] === 'steps') {
      const stepId = expression.path[1];
      if (!stepId || expression.path[2] !== 'outputs') return undefined;
      return getPath(context.stepOutputs[stepId], expression.path.slice(3));
    }
    return undefined;
  }
  if (expression.kind === 'unary') return !Boolean(evaluateExpression(expression.expr, context));

  const left = evaluateExpression(expression.left, context);
  const right = evaluateExpression(expression.right, context);
  switch (expression.op) {
    case 'and':
      return Boolean(left) && Boolean(right);
    case 'or':
      return Boolean(left) || Boolean(right);
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return comparable(left) > comparable(right);
    case '>=':
      return comparable(left) >= comparable(right);
    case '<':
      return comparable(left) < comparable(right);
    case '<=':
      return comparable(left) <= comparable(right);
  }
}

function comparable(value: unknown): string | number {
  if (typeof value === 'number' || typeof value === 'string') return value;
  throw new Error('Expression comparison requires string or number values.');
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
