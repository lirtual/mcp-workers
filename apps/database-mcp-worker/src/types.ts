export type Dialect = 'mysql' | 'postgres';
export type DatabaseTransport = 'direct' | 'hyperdrive';

export interface HyperdriveBinding {
  connectionString: string;
  host: string;
  user: string;
  password: string;
  database: string;
  port: number;
}

export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  CONNECTIONS_JSON: string;
  MCP_ACCESS_TOKEN?: string;
  MAX_ROWS?: string;
  MAX_RESULT_BYTES?: string;
  MAX_SCHEMA_BYTES?: string;
  QUERY_TIMEOUT_MS?: string;
  MAX_WRITE_AFFECTED_ROWS?: string;
  RATE_LIMITER: RateLimitBinding;
  [key: string]: unknown;
}

interface WriteConnectionBase {
  transport: DatabaseTransport;
  maxAffectedRows?: number;
}

export interface DirectWriteConnectionConfig extends WriteConnectionBase {
  transport: 'direct';
  urlSecret: string;
}

export interface HyperdriveWriteConnectionConfig extends WriteConnectionBase {
  transport: 'hyperdrive';
  binding: string;
}

export type WriteConnectionConfig = DirectWriteConnectionConfig | HyperdriveWriteConnectionConfig;

interface BaseConnectionConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  defaultSchema?: string;
  maxRows?: number;
  maxResultBytes?: number;
  maxSchemaBytes?: number;
  queryTimeoutMs?: number;
  write?: WriteConnectionConfig;
}

export interface DirectConnectionConfig extends BaseConnectionConfig {
  transport: 'direct';
  urlSecret: string;
}

export interface HyperdriveConnectionConfig extends BaseConnectionConfig {
  transport: 'hyperdrive';
  dialect: Dialect;
  binding: string;
}

export type ConnectionConfig = DirectConnectionConfig | HyperdriveConnectionConfig;

export interface RuntimeLimits {
  maxRows: number;
  maxResultBytes: number;
  maxSchemaBytes: number;
  queryTimeoutMs: number;
}

interface EffectiveDatabaseConnectionBase {
  config: ConnectionConfig;
  transport: DatabaseTransport;
  dialect: Dialect;
  connectionString: string;
  host: string;
  user: string;
  password: string;
  database: string;
  port: number;
  limits: RuntimeLimits;
}

export type EffectiveConnection = EffectiveDatabaseConnectionBase;

export interface EffectiveWriteConnection extends EffectiveDatabaseConnectionBase {
  maxAffectedRows: number;
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

export interface WriteResult {
  affectedRows: number;
  insertId?: number | string;
}

export type WritePredicate =
  | string
  | number
  | boolean
  | { eq: unknown }
  | { in: unknown[] }
  | { isNull: boolean };

export type WriteWhere = Record<string, WritePredicate>;

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
