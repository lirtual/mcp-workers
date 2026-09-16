import { PublicError } from './errors.js';
import type { ConnectionConfig, Dialect, EffectiveConnection, Env, HyperdriveBinding, RuntimeLimits } from './types.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BINDING_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_LIMITS: RuntimeLimits = {
  maxRows: 500,
  maxResultBytes: 1_048_576,
  maxSchemaBytes: 524_288,
  queryTimeoutMs: 15_000
};
const HARD_MAX = {
  maxRows: 5_000,
  maxResultBytes: 8 * 1024 * 1024,
  maxSchemaBytes: 4 * 1024 * 1024,
  queryTimeoutMs: 60_000
} as const;

function positiveInt(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > max) {
    throw new PublicError('INVALID_INPUT', `Invalid ${field} configuration.`);
  }
  return number;
}

function requiredString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new PublicError('INVALID_INPUT', `Invalid ${field} configuration.`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLength = 128): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maxLength);
}

function parseDialect(value: unknown): Dialect {
  if (value === 'mysql' || value === 'postgres') return value;
  throw new PublicError('INVALID_INPUT', 'Connection dialect must be mysql or postgres.');
}

export function getRuntimeLimits(env: Env): RuntimeLimits {
  return {
    maxRows: positiveInt(env.MAX_ROWS, 'MAX_ROWS', HARD_MAX.maxRows) ?? DEFAULT_LIMITS.maxRows,
    maxResultBytes:
      positiveInt(env.MAX_RESULT_BYTES, 'MAX_RESULT_BYTES', HARD_MAX.maxResultBytes) ?? DEFAULT_LIMITS.maxResultBytes,
    maxSchemaBytes:
      positiveInt(env.MAX_SCHEMA_BYTES, 'MAX_SCHEMA_BYTES', HARD_MAX.maxSchemaBytes) ?? DEFAULT_LIMITS.maxSchemaBytes,
    queryTimeoutMs:
      positiveInt(env.QUERY_TIMEOUT_MS, 'QUERY_TIMEOUT_MS', HARD_MAX.queryTimeoutMs) ?? DEFAULT_LIMITS.queryTimeoutMs
  };
}

export function parseConnectionCatalog(raw: string): ConnectionConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PublicError('INVALID_INPUT', 'CONNECTIONS_JSON is not valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50) {
    throw new PublicError('INVALID_INPUT', 'CONNECTIONS_JSON must contain 1 to 50 connections.');
  }

  const ids = new Set<string>();
  const result: ConnectionConfig[] = parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new PublicError('INVALID_INPUT', `Connection ${index} is invalid.`);
    }
    const item = entry as Record<string, unknown>;
    const id = requiredString(item.id, `connection[${index}].id`, 64);
    if (!ID_RE.test(id) || ids.has(id)) {
      throw new PublicError('INVALID_INPUT', `Connection id '${id}' is invalid or duplicated.`);
    }
    ids.add(id);
    const binding = requiredString(item.binding, `connection[${index}].binding`, 128);
    if (!BINDING_RE.test(binding)) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid binding name.`);
    }

    const enabled = item.enabled === undefined ? true : item.enabled;
    if (typeof enabled !== 'boolean') {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid enabled flag.`);
    }

    const config: ConnectionConfig = {
      id,
      displayName: requiredString(item.displayName, `connection[${index}].displayName`, 128),
      dialect: parseDialect(item.dialect),
      binding,
      enabled
    };
    const defaultSchema = optionalString(item.defaultSchema, `connection[${index}].defaultSchema`);
    if (defaultSchema !== undefined) config.defaultSchema = defaultSchema;
    const maxRows = positiveInt(item.maxRows, `connection[${index}].maxRows`, HARD_MAX.maxRows);
    if (maxRows !== undefined) config.maxRows = maxRows;
    const maxResultBytes = positiveInt(
      item.maxResultBytes,
      `connection[${index}].maxResultBytes`,
      HARD_MAX.maxResultBytes
    );
    if (maxResultBytes !== undefined) config.maxResultBytes = maxResultBytes;
    const maxSchemaBytes = positiveInt(
      item.maxSchemaBytes,
      `connection[${index}].maxSchemaBytes`,
      HARD_MAX.maxSchemaBytes
    );
    if (maxSchemaBytes !== undefined) config.maxSchemaBytes = maxSchemaBytes;
    const queryTimeoutMs = positiveInt(
      item.queryTimeoutMs,
      `connection[${index}].queryTimeoutMs`,
      HARD_MAX.queryTimeoutMs
    );
    if (queryTimeoutMs !== undefined) config.queryTimeoutMs = queryTimeoutMs;
    return config;
  });

  return result;
}

function isHyperdriveBinding(value: unknown): value is HyperdriveBinding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<HyperdriveBinding>;
  return (
    typeof candidate.connectionString === 'string' &&
    typeof candidate.host === 'string' &&
    typeof candidate.user === 'string' &&
    typeof candidate.password === 'string' &&
    typeof candidate.database === 'string' &&
    typeof candidate.port === 'number'
  );
}

export function resolveConnection(env: Env, catalog: ConnectionConfig[], id: string): EffectiveConnection {
  const config = catalog.find(item => item.id === id);
  if (!config) throw new PublicError('CONNECTION_NOT_FOUND', 'The requested logical connection does not exist.');
  if (!config.enabled) throw new PublicError('CONNECTION_DISABLED', 'The requested logical connection is disabled.');

  const candidate = env[config.binding];
  if (!isHyperdriveBinding(candidate)) {
    throw new PublicError('CONNECTION_UNAVAILABLE', 'The configured Hyperdrive binding is unavailable.');
  }
  const global = getRuntimeLimits(env);
  return {
    config,
    binding: candidate,
    limits: {
      maxRows: Math.min(config.maxRows ?? global.maxRows, global.maxRows),
      maxResultBytes: Math.min(config.maxResultBytes ?? global.maxResultBytes, global.maxResultBytes),
      maxSchemaBytes: Math.min(config.maxSchemaBytes ?? global.maxSchemaBytes, global.maxSchemaBytes),
      queryTimeoutMs: Math.min(config.queryTimeoutMs ?? global.queryTimeoutMs, global.queryTimeoutMs)
    }
  };
}
