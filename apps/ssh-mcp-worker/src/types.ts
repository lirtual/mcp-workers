export interface D1Result<T> {
  results: T[];
}

export interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
}

export interface D1Database {
  prepare(query: string): D1Statement;
}

export interface Env {
  MCP_ACCESS_TOKEN?: string;
  ENCRYPTION_KEY?: string;
  EDGE_SSH_DB?: D1Database;
}
