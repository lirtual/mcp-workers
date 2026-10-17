const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

const TERM = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/;

export function validExecInput(hostId: string, operationId: string, command: string, timeoutMs: number): string | null {
  if (!UUID.test(hostId) || !UUID.test(operationId) || typeof command !== 'string' || encoder.encode(command).byteLength > 16 * 1024
      || command.length === 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) return 'invalid_args';
  return null;
}

export function validSessionStartInput(hostId: string, operationId: string, termType: string | undefined): string | null {
  if (!UUID.test(hostId) || !UUID.test(operationId)) return 'invalid_args';
  if (termType !== undefined && !TERM.test(termType)) return 'invalid_args';
  return null;
}

export function validSessionLookupInput(sessionId: string, offset?: number, limit?: number): string | null {
  if (!UUID.test(sessionId)) return 'invalid_args';
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) return 'invalid_args';
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 64 * 1024)) return 'invalid_args';
  return null;
}

export function validSessionInput(sessionId: string, operationId: string, input: string): string | null {
  if (!UUID.test(sessionId) || !UUID.test(operationId) || typeof input !== 'string' || input.length === 0) return 'invalid_args';
  if (encoder.encode(input).byteLength > 16 * 1024) return 'invalid_args';
  return null;
}

export function validSessionStop(sessionId: string, operationId: string): string | null {
  if (!UUID.test(sessionId) || !UUID.test(operationId)) return 'invalid_args';
  return null;
}

export function validSftpInput(hostId: string, path: string, timeoutMs: number): string | null {
  if (!UUID.test(hostId) || typeof path !== 'string' || path.length === 0 || path.includes('\0')) return 'invalid_args';
  if (encoder.encode(path).byteLength > 4 * 1024) return 'invalid_args';
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) return 'invalid_args';
  return null;
}
