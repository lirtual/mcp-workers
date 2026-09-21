export async function assertWorkflowMcpHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/health`);
  if (!response.ok) {
    throw new Error(`Workflow MCP health failed with status ${response.status}.`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      (body as Record<string, unknown>).status !== 'ok') {
    throw new Error('Workflow MCP health payload is invalid.');
  }
}
