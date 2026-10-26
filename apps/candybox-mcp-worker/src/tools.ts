import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CandyError, shortenUrl, shareText, uploadFile, createDuckAddress,
  duckCapability, type Env, type Sender } from './operations.ts';

const output = <T extends Record<string, z.ZodTypeAny>>(shape: T) => z.object(shape).strict();
const status = z.literal('confirmed');
const shortenInput = z.object({
  url: z.url().max(4096), public_stats: z.boolean().default(false),
}).strict();
const textInput = z.object({
  text: z.string().max(16384), ttl_seconds: z.number().int().optional(),
  max_reads: z.number().int().optional(),
}).strict();
const fileInput = z.object({
  file: z.object({
    download_url: z.string().min(1).max(4096),
    file_id: z.string().min(1).max(256),
    mime_type: z.string().max(128).optional(),
    file_name: z.string().max(255).optional(),
  }).strict(), expires_in: z.enum(['1h','12h','24h','72h']).default('24h'),
}).strict();

const success = <T>(value: T) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});
const safe = async <T>(fn: () => Promise<T>) => {
  try { return success(await fn()); }
  catch (e) {
    const error = e instanceof CandyError ? e.code : 'upstream_error';
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
      structuredContent: { error } };
  }
};

export function buildMcpServer(env: Env, outbound: Sender = fetch): McpServer {
  const server = new McpServer({ name: 'candybox-mcp-worker', version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: 'CandyBox external writes are unavailable pending real ChatGPT per-invocation consent verification, trustworthy file delivery and upstream acceptance. A remembered tool approval does not establish per-call authorization. The capability tool is read-only and creates no remote data. Never promise generated links, uploads or aliases until a real provider confirms them.',
  });
  server.registerTool('candybox_capabilities', {
    description: 'Read current CandyBox availability without creating links, shares, files or aliases. All writes remain disabled until per-invocation host approval and relevant provider/file transfer gates are actually verified.',
    inputSchema: z.object({}).strict(),
    outputSchema: output({
      status: z.literal('partial_blocked'),
      shorten_url: z.literal('disabled_pending_approval'),
      share_text: z.literal('disabled_pending_approval'),
      upload_file: z.literal('disabled_pending_file_and_approval'),
      duck_address: z.enum(['not_configured','configured_unverified','ready','auth_failed','upstream_unavailable']),
      writes_available: z.literal(false),
      max_text_bytes: z.literal(16384), max_file_bytes: z.literal(10485760),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    // This probe is read-only and does not generate a Duck Address.
    const duck_address = await duckCapability(env, outbound);
    return success({ status: 'partial_blocked' as const,
      shorten_url: 'disabled_pending_approval' as const,
      share_text: 'disabled_pending_approval' as const,
      upload_file: 'disabled_pending_file_and_approval' as const,
      duck_address,
      writes_available: false as const,
      max_text_bytes: 16384 as const, max_file_bytes: 10485760 as const,
    });
  });
  return server;
}

// An isolated contract test fixture, deliberately NOT called from the production
// entrypoint. Real per-call host confirmation is not an MCP server-side primitive.
// No model-supplied approval boolean is accepted by any business tool.
export function registerUnreleasedWriteContracts(
  server: McpServer, env: Env, outbound: Sender, trustedFileHosts: string[] = [],
): void {
  server.registerTool('candybox_shorten_url', {
    description: 'CREATE a public dub.sh URL. External disclosure to Dub of the complete destination including query parameters. Preview full destination and request explicit per-call approval. Not safe to retry.',
    inputSchema: shortenInput,
    outputSchema: output({ status, short_link: z.string(), public_stats: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async args => safe(() => shortenUrl(args, outbound)));
  server.registerTool('candybox_share_text', {
    description: 'CREATE an EnvShare encrypted share. Original plaintext reaches ChatGPT and CandyBox; provider stores ciphertext. Preview content summary/expiry/reads and obtain fresh approval. Not safe to retry.',
    inputSchema: textInput,
    outputSchema: output({ status, share_url: z.string(), ttl_seconds: z.number(), max_reads: z.number() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async args => safe(() => shareText(args, outbound)));
  server.registerTool('candybox_upload_file', {
    description: 'UPLOAD one explicitly selected ChatGPT attachment in plaintext to Litterbox. Preview file name, actual size and retention; warn about sensitive filenames; obtain fresh approval. Not safe to retry.',
    inputSchema: fileInput,
    outputSchema: output({ status, file_url: z.string(), file_name: z.string(),
      size_bytes: z.number(), expires_in: z.enum(['1h','12h','24h','72h']) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { 'openai/fileParams': ['file'] },
  }, async args => safe(() => uploadFile(args, outbound, trustedFileHosts)));
  server.registerTool('candybox_create_duck_address', {
    description: 'CREATE a new persistent DuckDuckGo forwarding alias, not a temporary mailbox. Uses private Owner account; obtain fresh per-call approval. Not safe to retry.',
    inputSchema: z.object({}).strict(),
    outputSchema: output({ status, address: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async () => safe(() => createDuckAddress(env, outbound)));
}
