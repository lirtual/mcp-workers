const encoder = new TextEncoder();

export const MCP_TOOL_RESULT_MAX_BYTES = 64 * 1024;

// Reserve space for the JSON-RPC envelope and streamable HTTP/SSE framing.
const MCP_TRANSPORT_ENVELOPE_RESERVE_BYTES = 1024;

export function serializeMcpToolResult(value: unknown): { text: string; byteLength: number } {
  const text = JSON.stringify(value);
  const content = { content: [{ type: 'text', text }] };
  return {
    text,
    byteLength: encoder.encode(JSON.stringify(content)).byteLength + MCP_TRANSPORT_ENVELOPE_RESERVE_BYTES,
  };
}

export function fitsMcpToolResultBudget(value: unknown): boolean {
  return serializeMcpToolResult(value).byteLength <= MCP_TOOL_RESULT_MAX_BYTES;
}
