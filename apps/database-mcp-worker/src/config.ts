import { PublicError } from './errors.js';
import type {
  ConnectionConfig,
  Dialect,
  EffectiveConnection,
  EffectiveWriteConnection,
  Env,
  HyperdriveBinding,
  RuntimeLimits
} from './types.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
const DEFAULT_MAX_WRITE_AFFECTED_ROWS = 20;
const HARD_MAX_WRITE_AFFECTED_ROWS = 100;

interface ParsedDirectUrl {
  dialect: Dialect;
  connectionString: string;
  host: string;
  user: string;
  password: string;
  database: string;
  port: number;
}

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

function parseDialect(value: unknown): Dialect {
  if (value === 'mysql' || value === 'postgres') return value;
  throw new PublicError('INVALID_INPUT', 'Connection dialect must be mysql or postgres.');
}

function decodeUrlPart(value: string, connectionId: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PublicError('INVALID_INPUT', `Connection '${connectionId}' has an invalid direct database URL.`);
  }
}

function directUrlRequestsTls(url: URL): boolean {
  for (const [rawKey, rawValue] of url.searchParams) {
    const key = rawKey.toLowerCase();
    const value = rawValue.trim().toLowerCase();

    if (key === 'sslmode' || key === 'ssl-mode') {
      if (value === 'disable' || value === 'disabled') continue;
      return true;
    }

    if (key === 'ssl' || key === 'tls') {
      if (value === 'false' || value === '0' || value === 'disable' || value === 'disabled') continue;
      return true;
    }

    if (
      key.startsWith('ssl') ||
      key.startsWith('tls') ||
      key === 'rejectunauthorized' ||
      key === 'reject-unauthorized'
    ) {
      return true;
    }
  }
  return false;
}

export function parseDirectDatabaseUrl(raw: string, connectionId: string): ParsedDirectUrl {
  if (raw.length === 0 || raw.length > 8_192) {
    throw new PublicError('INVALID_INPUT', `Connection '${connectionId}' has an invalid direct database URL.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublicError('INVALID_INPUT', `Connection '${connectionId}' has an invalid direct database URL.`);
  }

  let dialect: Dialect;
  let defaultPort: number;
  if (url.protocol === 'postgres:' || url.protocol === 'postgresql:') {
    dialect = 'postgres';
    defaultPort = 5432;
  } else if (url.protocol === 'mysql:') {
    dialect = 'mysql';
    defaultPort = 3306;
  } else {
    throw new PublicError('INVALID_INPUT', `Connection '${connectionId}' uses an unsupported direct database URL scheme.`);
  }

  if (directUrlRequestsTls(url)) {
    throw new PublicError(
      'INVALID_INPUT',
      `Connection '${connectionId}' requests TLS in direct mode; use Hyperdrive for TLS-capable databases.`
    );
  }

  const database = decodeUrlPart(url.pathname.replace(/^\/+/, ''), connectionId);
  if (url.hostname.length === 0 || url.username.length === 0 || url.hash.length > 0) {
    throw new PublicError('INVALID_INPUT', `Connection '${connectionId}' has an invalid direct database URL.`);
  }
  if (dialect === 'postgres' && database.length === 0) {
    throw new PublicError('INVALID_INPUT', `Connection '${connectionId}' PostgreSQL URL must include a database name.`);
  }

  const port = url.port === '' ? defaultPort : Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new PublicError('INVALID_INPUT', `Connection '${connectionId}' has an invalid direct database port.`);
  }

  return {
    dialect,
    connectionString: raw,
    host: url.hostname,
    user: decodeUrlPart(url.username, connectionId),
    password: decodeUrlPart(url.password, connectionId),
    database,
    port
  };
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

export function getMaxWriteAffectedRows(env: Env): number {
  return (
    positiveInt(env.MAX_WRITE_AFFECTED_ROWS, 'MAX_WRITE_AFFECTED_ROWS', HARD_MAX_WRITE_AFFECTED_ROWS) ??
    DEFAULT_MAX_WRITE_AFFECTED_ROWS
  );
}

export function parseDatabaseConfig(raw: string): ConnectionConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG is not valid JSON.'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG must be a JSON object keyed by connection id.');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 50) {
    throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG must contain 1 to 50 connections.');
  }
  return entries.map(([id, value]) => {
    if (!ID_RE.test(id)) throw new PublicError('INVALID_INPUT', `Connection id '${id}' is invalid.`);
    if (typeof value === 'string') {
      parseDirectDatabaseUrl(value, id);
      return { id, transport: 'direct' as const, url: value };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' must be a SQL URL or strict Hyperdrive reference.`);
    }
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 2 || !Object.hasOwn(item, 'hyperdrive') || !Object.hasOwn(item, 'dialect')) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' must be a SQL URL or strict Hyperdrive reference.`);
    }
    const binding = requiredString(item.hyperdrive, `connection '${id}'.hyperdrive`, 128);
    if (!ENV_NAME_RE.test(binding)) throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid Hyperdrive binding name.`);
    return { id, transport: 'hyperdrive' as const, dialect: parseDialect(item.dialect), binding };
  });
}

function isHyperdriveBinding(value: unknown): value is HyperdriveBinding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<HyperdriveBinding>;
  return typeof candidate.connectionString === 'string' && typeof candidate.host === 'string' &&
    typeof candidate.user === 'string' && typeof candidate.password === 'string' &&
    typeof candidate.database === 'string' && typeof candidate.port === 'number';
}

function selectConnection(catalog: ConnectionConfig[], id?: string): ConnectionConfig {
  if (id === undefined) {
    if (catalog.length !== 1) throw new PublicError('INVALID_INPUT', 'A connection id is required when multiple connections are configured.');
    return catalog[0]!;
  }
  const config = catalog.find(item => item.id === id);
  if (!config) throw new PublicError('CONNECTION_NOT_FOUND', 'The requested logical connection does not exist.');
  return config;
}

export function resolveConnectionDialect(_env: Env, config: ConnectionConfig): Dialect {
  return config.transport === 'hyperdrive' ? config.dialect : parseDirectDatabaseUrl(config.url, config.id).dialect;
}

function effectiveLimits(env: Env): RuntimeLimits { return getRuntimeLimits(env); }

function resolveHyperdrive(env: Env, binding: string): HyperdriveBinding {
  const candidate = env[binding];
  if (!isHyperdriveBinding(candidate)) throw new PublicError('CONNECTION_UNAVAILABLE', 'The configured Hyperdrive binding is unavailable.');
  return candidate;
}

export function resolveConnection(env: Env, catalog: ConnectionConfig[], id?: string): EffectiveConnection {
  const config = selectConnection(catalog, id);
  const limits = effectiveLimits(env);
  if (config.transport === 'direct') {
    return { config, transport: 'direct', ...parseDirectDatabaseUrl(config.url, config.id), limits };
  }
  const candidate = resolveHyperdrive(env, config.binding);
  return { config, transport: 'hyperdrive', dialect: config.dialect, connectionString: candidate.connectionString,
    host: candidate.host, user: candidate.user, password: candidate.password, database: candidate.database,
    port: candidate.port, limits };
}

export function resolveWriteConnection(env: Env, catalog: ConnectionConfig[], id?: string): EffectiveWriteConnection {
  return { ...resolveConnection(env, catalog, id), maxAffectedRows: getMaxWriteAffectedRows(env) };
}
