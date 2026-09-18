export interface JsonSchemaIssue {
  path: string;
  message: string;
}

export function validateJsonSchemaValue(
  schema: unknown,
  value: unknown,
  path = '$'
): JsonSchemaIssue[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const node = schema as Record<string, unknown>;
  const issues: JsonSchemaIssue[] = [];

  if ('const' in node && value !== node.const) {
    issues.push({ path, message: 'value does not match const' });
    return issues;
  }

  if (Array.isArray(node.enum) && !node.enum.some(item => deepEqual(item, value))) {
    issues.push({ path, message: 'value is not in enum' });
  }

  const type = node.type;
  if (typeof type === 'string' && !matchesType(type, value)) {
    issues.push({ path, message: `expected ${type}` });
    return issues;
  }

  if (type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const properties =
      node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
        ? (node.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(node.required)
      ? node.required.filter((item): item is string => typeof item === 'string')
      : [];

    for (const key of required) {
      if (!(key in objectValue)) issues.push({ path: `${path}.${key}`, message: 'required property is missing' });
    }

    for (const [key, child] of Object.entries(objectValue)) {
      if (key in properties) {
        issues.push(...validateJsonSchemaValue(properties[key], child, `${path}.${key}`));
      } else if (node.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, message: 'additional property is not allowed' });
      }
    }
  }

  if (type === 'array' && Array.isArray(value) && node.items) {
    value.forEach((item, index) => {
      issues.push(...validateJsonSchemaValue(node.items, item, `${path}[${index}]`));
    });
  }

  return issues;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
