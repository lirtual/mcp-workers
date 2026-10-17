const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export function validExecInput(hostId: string, operationId: string, command: string, timeoutMs: number): string | null {
  if (!UUID.test(hostId) || !UUID.test(operationId) || typeof command !== 'string' || encoder.encode(command).byteLength > 16 * 1024
      || command.length === 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) return 'invalid_args';
  return null;
}
