/** Local read_file arguments accepted by the Worker. Enforced again by the agent. */
export interface LocalRead {
  path: string;
  offset?: number;
  length?: number;
}

const ALLOWED_KEYS = new Set(["path", "offset", "length", "isUrl"]);
const MAX_PATH_LENGTH = 4096;
const MIN_OFFSET = -100_000;
const MAX_OFFSET = 1_000_000;
const MAX_LENGTH = 1000;

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function hasUriScheme(path: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path);
}

export function parseLocalRead(input: unknown): LocalRead | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key)) return null;
  }

  if (record.isUrl !== undefined && record.isUrl !== false) return null;

  const filePath = record.path;
  if (typeof filePath !== "string") return null;
  if (filePath.length === 0 || filePath.length > MAX_PATH_LENGTH) return null;
  if (filePath.includes("\0") || filePath.startsWith("//") || hasUriScheme(filePath)) return null;

  const read: LocalRead = { path: filePath };
  if (record.offset !== undefined) {
    if (!isIntegerInRange(record.offset, MIN_OFFSET, MAX_OFFSET)) return null;
    read.offset = record.offset;
  }
  if (record.length !== undefined) {
    if (!isIntegerInRange(record.length, 1, MAX_LENGTH)) return null;
    read.length = record.length;
  }
  return read;
}
