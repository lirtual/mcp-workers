import { createHash } from 'node:crypto';

export interface RaindropRunEvidence {
  returnedCount: number;
  totalCount: number;
  recordsSha256: string;
}

/**
 * Verify result contract without returning bookmark URLs or credentials in
 * CI logs / deployment evidence. "count" is the upstream total, not page size.
 */
export function verifyRaindropOutput(outputs: unknown): RaindropRunEvidence {
  if (!isRecord(outputs)) throw new Error('Raindrop workflow outputs must be an object.');
  const records = outputs.bookmarks;
  if (!Array.isArray(records) || records.length > 20 ||
      records.some(item => !isRecord(item))) {
    throw new Error('Raindrop bookmarks must contain 0–20 structured records.');
  }
  const total = outputs.count;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) ||
      total < records.length || total < 0) {
    throw new Error('Raindrop upstream count is invalid.');
  }
  return {
    returnedCount: records.length,
    totalCount: total,
    recordsSha256: createHash('sha256').update(JSON.stringify(records)).digest('hex')
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
