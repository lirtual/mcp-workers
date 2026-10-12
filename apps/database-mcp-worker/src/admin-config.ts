import {
  getRuntimeLimits,
  parseDatabaseConfig,
  parseDirectDatabaseUrl,
  resolveConnectionDialect
} from './config.js';
import { PublicError } from './errors.js';
import type {
  AdminConnectionConfig,
  ConnectionConfig,
  DirectAdminConnectionConfig,
  EffectiveAdminConnection,
  Env,
  HyperdriveAdminConnectionConfig,
  RuntimeLimits
} from './types.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseAdmin(value: unknown, id: string): AdminConnectionConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    parseDirectDatabaseUrl(value, id);
    const config: DirectAdminConnectionConfig = { transport: 'direct', url: value };
    return config;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' has an invalid admin configuration.`);
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length !== 1 || keys[0] !== 'hyperdrive' || typeof item.hyperdrive !== 'string' || !ENV_NAME_RE.test(item.hyperdrive)) {
    throw new PublicError('INVALID_INPUT', `Connection '${id}' admin must be a SQL URL or a Hyperdrive reference.`);
  }
  const config: HyperdriveAdminConnectionConfig = { transport: 'hyperdrive', binding: item.hyperdrive };
  return config;
}

export function parseDatabaseConfigWithAdmin(raw: string): ConnectionConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG must be a JSON object keyed by connection id.');
  }

  const source = parsed as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  const admins = new Map<string, AdminConnectionConfig>();

  for (const [id, value] of Object.entries(source)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      stripped[id] = value;
      continue;
    }
    const item = value as Record<string, unknown>;
    const admin = parseAdmin(item.admin, id);
    if (admin !== undefined) admins.set(id, admin);
    const withoutAdmin = { ...item };
    delete withoutAdmin.admin;
    stripped[id] = withoutAdmin;
  }

  const catalog = parseDatabaseConfig(JSON.stringify(stripped));
  for (const config of catalog) {
    const admin = admins.get(config.id);
    if (admin !== undefined) config.admin = admin;
  }
  return catalog;
}

function limitsFor(env: Env, config: ConnectionConfig): RuntimeLimits {
  const global = getRuntimeLimits(env);
  return {
    maxRows: Math.min(config.maxRows ?? global.maxRows, global.maxRows),
    maxResultBytes: Math.min(config.maxResultBytes ?? global.maxResultBytes, global.maxResultBytes),
    maxSchemaBytes: Math.min(config.maxSchemaBytes ?? global.maxSchemaBytes, global.maxSchemaBytes),
    queryTimeoutMs: Math.min(config.queryTimeoutMs ?? global.queryTimeoutMs, global.queryTimeoutMs)
  };
}

export function resolveAdminConnection(
  env: Env,
  catalog: ConnectionConfig[],
  id: string
): EffectiveAdminConnection {
  const config = catalog.find(item => item.id === id);
  if (!config) throw new PublicError('CONNECTION_NOT_FOUND', 'The requested logical connection does not exist.');
  if (!config.enabled) throw new PublicError('CONNECTION_DISABLED', 'The requested logical connection is disabled.');
  const admin = config.admin;
  if (admin === undefined) {
    throw new PublicError('ADMIN_NOT_CONFIGURED', 'The requested logical connection does not have admin access configured.');
  }

  const dialect = resolveConnectionDialect(env, config);
  const limits = limitsFor(env, config);

  if (admin.transport === 'hyperdrive') {
    throw new PublicError(
      'ADMIN_OPERATION_NOT_SUPPORTED',
      'Safe Admin over Hyperdrive is not enabled in v0.3 because DDL compatibility has not been verified for this transport; configure an explicit direct ADMIN connection instead.'
    );
  }

  if (typeof admin.url !== 'string' || admin.url.length === 0) {
    throw new PublicError('CONNECTION_UNAVAILABLE', 'The configured direct database URL for admin access is unavailable.');
  }
  const direct = parseDirectDatabaseUrl(admin.url, config.id);
  if (direct.dialect !== dialect) {
    throw new PublicError('INVALID_INPUT', `Connection '${config.id}' has mismatched read and admin database dialects.`);
  }
  return { config, transport: 'direct', ...direct, limits };
}
