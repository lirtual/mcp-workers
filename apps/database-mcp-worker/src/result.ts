import { PublicError } from './errors.js';
import type { QueryColumn, QueryResult } from './types.js';

const encoder = new TextEncoder();

function base64Bytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[max-depth]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return { encoding: 'base64', data: base64Bytes(value) };
  if (Array.isArray(value)) return value.map(item => jsonSafe(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = jsonSafe(child, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function boundQueryResult(
  columns: QueryColumn[],
  rows: unknown[][],
  requestedLimit: number,
  maxBytes: number
): QueryResult {
  const maxRows = Math.max(1, Math.trunc(requestedLimit));
  const outputRows: unknown[][] = [];
  let bytes = encoder.encode(JSON.stringify({ columns, rows: [] })).byteLength;
  let truncated = rows.length > maxRows;
  let truncationReason: QueryResult['truncationReason'] = truncated ? 'row_limit' : undefined;

  for (const row of rows.slice(0, maxRows)) {
    const safeRow = row.map(value => jsonSafe(value));
    const encoded = encoder.encode(JSON.stringify(safeRow)).byteLength + 1;
    if (bytes + encoded > maxBytes) {
      truncated = true;
      truncationReason = 'result_size';
      break;
    }
    outputRows.push(safeRow);
    bytes += encoded;
  }

  const result: QueryResult = {
    columns,
    rows: outputRows,
    rowCount: outputRows.length,
    truncated
  };
  if (truncationReason !== undefined) result.truncationReason = truncationReason;
  return result;
}

export function assertJsonWithinBytes(value: unknown, maxBytes: number): void {
  const bytes = encoder.encode(JSON.stringify(jsonSafe(value))).byteLength;
  if (bytes > maxBytes) {
    throw new PublicError('RESULT_LIMIT_EXCEEDED', 'The response exceeds the configured payload limit.');
  }
}

export function clampRequestedLimit(requested: number | undefined, maxRows: number): number {
  if (requested === undefined) return maxRows;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new PublicError('INVALID_INPUT', 'rowLimit must be a positive integer.');
  }
  return Math.min(requested, maxRows);
}
