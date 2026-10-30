export type Dialect = 'mysql' | 'postgres';
export type DatabaseTransport = 'direct' | 'hyperdrive';
export interface HyperdriveBinding {
  // Cloudflare's documented per-Worker proxy connection fields.
  connectionString: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB?: D1Database;
  DATABASE_SETUP_HOST?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
  SETUP_RATE_LIMITER?: RateLimitBinding;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_KEY_ID?: string;
  DATABASE_ENCRYPTION_PREVIOUS_KEY?: string;
  DATABASE_PREVIOUS_KEY_ID?: string;
  MCP_ACCESS_TOKEN?: string;
  DATABASE_GITHUB_ACTIONS_TOKEN?: string;
  MAX_ROWS?: string;
  MAX_RESULT_BYTES?: string;
  MAX_SCHEMA_BYTES?: string;
  QUERY_TIMEOUT_MS?: string;
  MAX_WRITE_AFFECTED_ROWS?: string;
  RATE_LIMITER: RateLimitBinding;
  [key: string]: unknown;
}

interface BaseConnectionConfig { id: string; }

export interface DirectConnectionConfig extends BaseConnectionConfig {
  transport: 'direct';
  url: string;
}

export interface HyperdriveConnectionConfig extends BaseConnectionConfig {
  transport: 'hyperdrive';
  configId: string;
  bindingName: string;
}
export type ConnectionConfig = DirectConnectionConfig | HyperdriveConnectionConfig;

export interface RuntimeLimits {
  maxRows: number;
  maxResultBytes: number;
  maxSchemaBytes: number;
  queryTimeoutMs: number;
}

export interface EffectiveConnection {
  config: ConnectionConfig;
  transport: DatabaseTransport;
  dialect: Dialect;
  connectionString: string;
  host: string;
  // Public IP vetted by DNS admission, pinned for the Direct TCP dial only.
  dialHost?: string;
  user: string;
  password: string;
  database: string;
  // Hyperdrive MySQL uses a proxy database for the driver handshake, which
  // may differ from the reviewed origin schema used in SQL identifiers.
  proxyDatabase?: string;
  port: number;
  ca?: string;
  limits: RuntimeLimits;
}

export interface EffectiveWriteConnection extends EffectiveConnection {
  maxAffectedRows: number;
}

export type EffectiveAdminConnection = EffectiveConnection;

export interface WriteResult {
  affectedRows: number;
  insertId?: number | string;
}

export interface AdminResult {
  ok: true;
  operation: string;
}

export interface QueryColumn {
  name: string;
  type?: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  truncationReason?: 'row_limit' | 'result_size';
}

export interface SchemaInspection {
  dialect: Dialect;
  schema?: string;
  table?: string;
  schemas?: string[];
  tables?: Array<{ schema: string; name: string; type: string }>;
  columns?: Array<{
    name: string;
    dataType: string;
    nullable: boolean;
    defaultValue?: unknown;
    ordinalPosition: number;
    extra?: string;
  }>;
  primaryKeys?: Array<{ constraintName: string; column: string; ordinalPosition: number }>;
  foreignKeys?: Array<{
    constraintName: string;
    column: string;
    referencedSchema?: string;
    referencedTable: string;
    referencedColumn: string;
    ordinalPosition: number;
  }>;
  indexes?: Array<{
    name: string;
    unique: boolean;
    columns?: string[];
    definition?: string;
    type?: string;
  }>;
}

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
}
