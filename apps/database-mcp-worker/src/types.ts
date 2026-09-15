export type Dialect = 'mysql' | 'postgres';

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
  /** Expand-phase fixed credential used only from Cloudflare MCP Portal to this Worker. */
  MCP_ORIGIN_TOKEN?: string;
  /** Legacy client-facing OAuth resource-server configuration retained until contract cutover. */
  OAUTH_ISSUER: string;
  OAUTH_AUDIENCE: string;
  OAUTH_JWKS_URL: string;
  OAUTH_REQUIRED_SCOPE?: string;
  MAX_ROWS?: string;
  MAX_RESULT_BYTES?: string;
  MAX_SCHEMA_BYTES?: string;
  QUERY_TIMEOUT_MS?: string;
  RATE_LIMITER: RateLimitBinding;
  [key: string]: unknown;
}

export interface ConnectionConfig {
  id: string;
  displayName: string;
  dialect: Dialect;
  binding: string;
  enabled: boolean;
  defaultSchema?: string;
  maxRows?: number;
  maxResultBytes?: number;
  maxSchemaBytes?: number;
  queryTimeoutMs?: number;
}

export interface RuntimeLimits {
  maxRows: number;
  maxResultBytes: number;
  maxSchemaBytes: number;
  queryTimeoutMs: number;
}

export interface EffectiveConnection {
  config: ConnectionConfig;
  binding: HyperdriveBinding;
  limits: RuntimeLimits;
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
