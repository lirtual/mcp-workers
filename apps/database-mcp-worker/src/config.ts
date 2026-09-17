import { PublicError } from './errors.js';
import type {
  ConnectionConfig,
  DatabaseTransport,
  Dialect,
  DirectConnectionConfig,
  DirectWriteConnectionConfig,
  EffectiveConnection,
  EffectiveWriteConnection,
  Env,
  HyperdriveBinding,
  HyperdriveConnectionConfig,
  HyperdriveWriteConnectionConfig,
  RuntimeLimits,
  WriteConnectionConfig
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

function optionalString(value: unknown, field: string, maxLength = 128): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, maxLength);
}

function parseDialect(value: unknown): Dialect {
  if (value === 'mysql' || value === 'postgres') return value;
  throw new PublicError('INVALID_INPUT', 'Connection dialect must be mysql or postgres.');
}

function parseTransport(value: unknown): DatabaseTransport {
  if (value === 'direct' || value === 'hyperdrive') return value;
  throw new PublicError('INVALID_INPUT', 'Connection transport must be direct or hyperdrive.');
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
  if (url.hostname.length === 0 || url.username.length === 0 || database.length === 0 || url.hash.length > 0) {
    throw new PublicError('INVALID_INPUT', `Connection '${connectionId}' has an invalid direct database URL.`);
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

function parseDatabaseConfigWrite(value: unknown, id: string, maxAffectedRows?: number): WriteConnectionConfig | undefined {
  if (value === undefined) return undefined;

  if (typeof value === 'string') {
    parseDirectDatabaseUrl(value, id);
    const config: DirectWriteConnectionConfig = {
      transport: 'direct',
      url: value,
      ...(maxAffectedRows === undefined ? {} : { maxAffectedRows })
    };
    return config;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid write configuration.`);
  }

  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length !== 1 || keys[0] !== 'hyperdrive') {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' write must be a SQL URL or a Hyperdrive reference.`);
  }

  const binding = requiredString(item.hyperdrive, `connection '${id}'.write.hyperdrive`, 128);
  if (!ENV_NAME_RE.test(binding)) {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid write Hyperdrive binding name.`);
  }
  const config: HyperdriveWriteConnectionConfig = {
    transport: 'hyperdrive',
    binding,
    ...(maxAffectedRows === undefined ? {} : { maxAffectedRows })
  };
  return config;
}

function databaseConfigCommon(item: Record<string, unknown>, id: string) {
  const enabled = item.enabled === undefined ? true : item.enabled;
  if (typeof enabled !== 'boolean') {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid enabled flag.`);
  }

  const displayName = optionalString(item.displayName, `connection '${id}'.displayName`, 128) ?? id;
  const maxAffectedRows = positiveInt(
    item.maxAffectedRows,
    `connection '${id}'.maxAffectedRows`,
    HARD_MAX_WRITE_AFFECTED_ROWS
  );
  const write = parseDatabaseConfigWrite(item.write, id, maxAffectedRows);
  if (maxAffectedRows !== undefined && write === undefined) {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' sets maxAffectedRows without write access.`);
  }

  const optional: {
    defaultSchema?: string;
    maxRows?: number;
    maxResultBytes?: number;
    maxSchemaBytes?: number;
    queryTimeoutMs?: number;
  } = {};

  const defaultSchema = optionalString(item.defaultSchema, `connection '${id}'.defaultSchema`);
  if (defaultSchema !== undefined) optional.defaultSchema = defaultSchema;
  const maxRows = positiveInt(item.maxRows, `connection '${id}'.maxRows`, HARD_MAX.maxRows);
  if (maxRows !== undefined) optional.maxRows = maxRows;
  const maxResultBytes = positiveInt(item.maxResultBytes, `connection '${id}'.maxResultBytes`, HARD_MAX.maxResultBytes);
  if (maxResultBytes !== undefined) optional.maxResultBytes = maxResultBytes;
  const maxSchemaBytes = positiveInt(item.maxSchemaBytes, `connection '${id}'.maxSchemaBytes`, HARD_MAX.maxSchemaBytes);
  if (maxSchemaBytes !== undefined) optional.maxSchemaBytes = maxSchemaBytes;
  const queryTimeoutMs = positiveInt(item.queryTimeoutMs, `connection '${id}'.queryTimeoutMs`, HARD_MAX.queryTimeoutMs);
  if (queryTimeoutMs !== undefined) optional.queryTimeoutMs = queryTimeoutMs;

  return {
    id,
    displayName,
    enabled,
    ...(write === undefined ? {} : { write }),
    ...optional
  };
}

export function parseDatabaseConfig(raw: string): ConnectionConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG must be a JSON object keyed by connection id.');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 50) {
    throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG must contain 1 to 50 connections.');
  }

  return entries.map(([id, value]) => {
    if (!ID_RE.test(id)) {
      throw new PublicError('INVALID_INPUT', `Connection id '${id}' is invalid.`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' is invalid.`);
    }

    const item = value as Record<string, unknown>;
    const allowedFields = new Set([
      'displayName',
      'read',
      'write',
      'enabled',
      'defaultSchema',
      'maxRows',
      'maxResultBytes',
      'maxSchemaBytes',
      'queryTimeoutMs',
      'maxAffectedRows'
    ]);
    for (const key of Object.keys(item)) {
      if (!allowedFields.has(key)) {
        throw new PublicError('INVALID_INPUT', `Connection '${id}' has unsupported configuration field '${key}'.`);
      }
    }

    const common = databaseConfigCommon(item, id);
    const read = item.read;
    if (typeof read === 'string') {
      parseDirectDatabaseUrl(read, id);
      const config: DirectConnectionConfig = { ...common, transport: 'direct', url: read };
      return config;
    }

    if (typeof read !== 'object' || read === null || Array.isArray(read)) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' must define read as a SQL URL or Hyperdrive reference.`);
    }

    const readItem = read as Record<string, unknown>;
    const readKeys = Object.keys(readItem);
    if (readKeys.length !== 2 || !readKeys.includes('hyperdrive') || !readKeys.includes('dialect')) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' Hyperdrive read requires hyperdrive and dialect.`);
    }
    const binding = requiredString(readItem.hyperdrive, `connection '${id}'.read.hyperdrive`, 128);
    if (!ENV_NAME_RE.test(binding)) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid Hyperdrive binding name.`);
    }
    const config: HyperdriveConnectionConfig = {
      ...common,
      transport: 'hyperdrive',
      dialect: parseDialect(readItem.dialect),
      binding
    };
    return config;
  });
}

// Legacy parser retained for compatibility with existing tests/config migrations.
function parseWriteConnectionConfig(value: unknown, index: number, id: string): WriteConnectionConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid write configuration.`);
  }

  const item = value as Record<string, unknown>;
  const allowedFields = new Set(['transport', 'urlSecret', 'binding', 'maxAffectedRows']);
  for (const key of Object.keys(item)) {
    if (!allowedFields.has(key)) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' has unsupported write configuration.`);
    }
  }

  const transport = parseTransport(item.transport);
  const maxAffectedRows = positiveInt(item.maxAffectedRows, `connection[${index}].write.maxAffectedRows`, HARD_MAX_WRITE_AFFECTED_ROWS);
  const optionalLimit = maxAffectedRows === undefined ? {} : { maxAffectedRows };

  if (transport === 'direct') {
    if (item.binding !== undefined) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' cannot declare a write binding for direct transport.`);
    }
    const urlSecret = requiredString(item.urlSecret, `connection[${index}].write.urlSecret`, 128);
    if (!ENV_NAME_RE.test(urlSecret)) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid write URL secret name.`);
    }
    return { transport: 'direct', urlSecret, ...optionalLimit };
  }

  if (item.urlSecret !== undefined) {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' cannot declare a write urlSecret for Hyperdrive.`);
  }
  const binding = requiredString(item.binding, `connection[${index}].write.binding`, 128);
  if (!ENV_NAME_RE.test(binding)) {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid write binding name.`);
  }
  return { transport: 'hyperdrive', binding, ...optionalLimit };
}

function commonConnectionFields(item: Record<string, unknown>, index: number, id: string) {
  const enabled = item.enabled === undefined ? true : item.enabled;
  if (typeof enabled !== 'boolean') {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid enabled flag.`);
  }

  const write = parseWriteConnectionConfig(item.write, index, id);
  const common = {
    id,
    displayName: requiredString(item.displayName, `connection[${index}].displayName`, 128),
    enabled,
    ...(write === undefined ? {} : { write })
  } as const;

  const optional: {
    defaultSchema?: string;
    maxRows?: number;
    maxResultBytes?: number;
    maxSchemaBytes?: number;
    queryTimeoutMs?: number;
  } = {};

  const defaultSchema = optionalString(item.defaultSchema, `connection[${index}].defaultSchema`);
  if (defaultSchema !== undefined) optional.defaultSchema = defaultSchema;
  const maxRows = positiveInt(item.maxRows, `connection[${index}].maxRows`, HARD_MAX.maxRows);
  if (maxRows !== undefined) optional.maxRows = maxRows;
  const maxResultBytes = positiveInt(item.maxResultBytes, `connection[${index}].maxResultBytes`, HARD_MAX.maxResultBytes);
  if (maxResultBytes !== undefined) optional.maxResultBytes = maxResultBytes;
  const maxSchemaBytes = positiveInt(item.maxSchemaBytes, `connection[${index}].maxSchemaBytes`, HARD_MAX.maxSchemaBytes);
  if (maxSchemaBytes !== undefined) optional.maxSchemaBytes = maxSchemaBytes;
  const queryTimeoutMs = positiveInt(item.queryTimeoutMs, `connection[${index}].queryTimeoutMs`, HARD_MAX.queryTimeoutMs);
  if (queryTimeoutMs !== undefined) optional.queryTimeoutMs = queryTimeoutMs;

  return { ...common, ...optional };
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
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new PublicError('INVALID_INPUT', `Connection ${index} is invalid.`);
    }

    const item = entry as Record<string, unknown>;
    const id = requiredString(item.id, `connection[${index}].id`, 64);
    if (!ID_RE.test(id) || ids.has(id)) {
      throw new PublicError('INVALID_INPUT', `Connection id '${id}' is invalid or duplicated.`);
    }
    ids.add(id);

    const transport = parseTransport(item.transport);
    const common = commonConnectionFields(item, index, id);

    if (transport === 'direct') {
      if (item.binding !== undefined || item.dialect !== undefined) {
        throw new PublicError('INVALID_INPUT', `Connection '${id}' cannot declare binding or dialect when transport is direct.`);
      }
      for (const field of ['host', 'port', 'user', 'username', 'password', 'database', 'tls', 'ssl']) {
        if (item[field] !== undefined) {
          throw new PublicError('INVALID_INPUT', `Connection '${id}' uses unsupported split direct configuration.`);
        }
      }
      const urlSecret = requiredString(item.urlSecret, `connection[${index}].urlSecret`, 128);
      if (!ENV_NAME_RE.test(urlSecret)) {
        throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid URL secret name.`);
      }
      return { ...common, transport: 'direct', urlSecret };
    }

    if (item.urlSecret !== undefined) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' cannot declare urlSecret when transport is hyperdrive.`);
    }
    const binding = requiredString(item.binding, `connection[${index}].binding`, 128);
    if (!ENV_NAME_RE.test(binding)) {
      throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid binding name.`);
    }
    return { ...common, transport: 'hyperdrive', dialect: parseDialect(item.dialect), binding };
  });
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

function directUrlFromConfig(
  env: Env,
  config: { url?: string; urlSecret?: string },
  connectionId: string,
  capability: 'read' | 'write'
): ParsedDirectUrl {
  if (typeof config.url === 'string' && config.url.length > 0) {
    return parseDirectDatabaseUrl(config.url, connectionId);
  }
  if (typeof config.urlSecret === 'string') {
    const candidate = env[config.urlSecret];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return parseDirectDatabaseUrl(candidate, connectionId);
    }
  }
  throw new PublicError('CONNECTION_UNAVAILABLE', `The configured direct database URL for ${capability} access is unavailable.`);
}

export function resolveConnectionDialect(env: Env, config: ConnectionConfig): Dialect {
  return config.transport === 'hyperdrive' ? config.dialect : directUrlFromConfig(env, config, config.id, 'read').dialect;
}

function effectiveLimits(env: Env, config: ConnectionConfig): RuntimeLimits {
  const global = getRuntimeLimits(env);
  return {
    maxRows: Math.min(config.maxRows ?? global.maxRows, global.maxRows),
    maxResultBytes: Math.min(config.maxResultBytes ?? global.maxResultBytes, global.maxResultBytes),
    maxSchemaBytes: Math.min(config.maxSchemaBytes ?? global.maxSchemaBytes, global.maxSchemaBytes),
    queryTimeoutMs: Math.min(config.queryTimeoutMs ?? global.queryTimeoutMs, global.queryTimeoutMs)
  };
}

function requireLogicalConnection(catalog: ConnectionConfig[], id: string): ConnectionConfig {
  const config = catalog.find(item => item.id === id);
  if (!config) throw new PublicError('CONNECTION_NOT_FOUND', 'The requested logical connection does not exist.');
  if (!config.enabled) throw new PublicError('CONNECTION_DISABLED', 'The requested logical connection is disabled.');
  return config;
}

function resolveHyperdrive(env: Env, binding: string): HyperdriveBinding {
  const candidate = env[binding];
  if (!isHyperdriveBinding(candidate)) {
    throw new PublicError('CONNECTION_UNAVAILABLE', 'The configured Hyperdrive binding is unavailable.');
  }
  return candidate;
}

export function resolveConnection(env: Env, catalog: ConnectionConfig[], id: string): EffectiveConnection {
  const config = requireLogicalConnection(catalog, id);
  const limits = effectiveLimits(env, config);

  if (config.transport === 'direct') {
    const direct = directUrlFromConfig(env, config, config.id, 'read');
    return { config, transport: 'direct', ...direct, limits };
  }

  const candidate = resolveHyperdrive(env, config.binding);
  return {
    config,
    transport: 'hyperdrive',
    dialect: config.dialect,
    connectionString: candidate.connectionString,
    host: candidate.host,
    user: candidate.user,
    password: candidate.password,
    database: candidate.database,
    port: candidate.port,
    limits
  };
}

export function resolveWriteConnection(env: Env, catalog: ConnectionConfig[], id: string): EffectiveWriteConnection {
  const config = requireLogicalConnection(catalog, id);
  const write = config.write;
  if (write === undefined) {
    throw new PublicError('WRITE_NOT_CONFIGURED', 'The requested logical connection does not have write access configured.');
  }

  const dialect = resolveConnectionDialect(env, config);
  const limits = effectiveLimits(env, config);
  const deploymentMax = getMaxWriteAffectedRows(env);
  const maxAffectedRows = Math.min(write.maxAffectedRows ?? deploymentMax, deploymentMax);

  if (write.transport === 'direct') {
    const direct = directUrlFromConfig(env, write, config.id, 'write');
    if (direct.dialect !== dialect) {
      throw new PublicError('INVALID_INPUT', `Connection '${config.id}' has mismatched read and write database dialects.`);
    }
    return { config, transport: 'direct', ...direct, limits, maxAffectedRows };
  }

  const candidate = resolveHyperdrive(env, write.binding);
  return {
    config,
    transport: 'hyperdrive',
    dialect,
    connectionString: candidate.connectionString,
    host: candidate.host,
    user: candidate.user,
    password: candidate.password,
    database: candidate.database,
    port: candidate.port,
    limits,
    maxAffectedRows
  };
}
