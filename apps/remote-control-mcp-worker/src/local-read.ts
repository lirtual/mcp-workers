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

export const MAX_BATCH_FILES = 8;
export const MAX_DIRECTORY_DEPTH = 3;
export const DEFAULT_DIRECTORY_DEPTH = 1;
export const MAX_DIRECTORY_ENTRIES = 100;

export interface LocalReadMultiple {
  paths: string[];
}

export interface LocalListDirectory {
  path: string;
  depth: number;
}

export interface LocalFileInfo {
  path: string;
}

function parsePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return null;
  if (value.includes("\0") || value.startsWith("//") || hasUriScheme(value)) return null;
  return value;
}

export function parseReadMultiple(input: unknown): LocalReadMultiple | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "paths")) return null;
  if (!Array.isArray(record.paths) || record.paths.length === 0 || record.paths.length > MAX_BATCH_FILES) {
    return null;
  }
  const paths: string[] = [];
  for (const entry of record.paths) {
    const filePath = parsePath(entry);
    if (!filePath) return null;
    paths.push(filePath);
  }
  return { paths };
}

export function parseListDirectory(input: unknown): LocalListDirectory | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "path" && key !== "depth")) return null;
  const directoryPath = parsePath(record.path);
  if (!directoryPath) return null;
  if (record.depth === undefined) return { path: directoryPath, depth: DEFAULT_DIRECTORY_DEPTH };
  if (!isIntegerInRange(record.depth, 1, MAX_DIRECTORY_DEPTH)) return null;
  return { path: directoryPath, depth: record.depth };
}

export function parseFileInfo(input: unknown): LocalFileInfo | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "path")) return null;
  const filePath = parsePath(record.path);
  if (!filePath) return null;
  return { path: filePath };
}
