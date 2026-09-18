import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface RunnerManifest {
  version: 1;
  runId: string;
  stepRunId: string;
  attemptId: string;
  operationId: string;
  capability: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
}

interface RunnerEnv {
  ATTEMPT_ID?: string;
  CLAIM_NONCE?: string;
  WORKFLOW_MCP_URL?: string;
  WORKFLOW_MCP_OIDC_AUDIENCE?: string;
  ACTIONS_ID_TOKEN_REQUEST_URL?: string;
  ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string;
  GITHUB_RUN_ID?: string;
  GITHUB_RUN_ATTEMPT?: string;
  RUNNER_TEMP?: string;
}

export async function runExecutor(
  env: RunnerEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<{ claimed: boolean }> {
  const attemptId = required(env.ATTEMPT_ID, 'ATTEMPT_ID');
  const claimNonce = required(env.CLAIM_NONCE, 'CLAIM_NONCE');
  const baseUrl = required(env.WORKFLOW_MCP_URL, 'WORKFLOW_MCP_URL').replace(/\/+$/, '');
  const audience = env.WORKFLOW_MCP_OIDC_AUDIENCE || 'workflow-mcp-worker';
  const oidcToken = await requestOidcToken(env, audience, fetchImpl);

  const claimResponse = await fetchImpl(`${baseUrl}/executor/claim`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oidcToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ attemptId, claimNonce })
  });

  if (claimResponse.status === 409) {
    const body = await safeJson(claimResponse);
    const code = readErrorCode(body);
    if (code === 'ATTEMPT_CLAIM_REJECTED' || code === 'RUN_NOT_CLAIMABLE') {
      console.log(`Candidate Job did not win Claim (${code}); exiting without business work.`);
      return { claimed: false };
    }
  }
  if (!claimResponse.ok) {
    throw new Error(`Claim failed with status ${claimResponse.status}.`);
  }

  const claim = (await claimResponse.json()) as { lease?: string };
  const lease = required(claim.lease, 'claim lease');

  const manifestResponse = await fetchImpl(`${baseUrl}/executor/manifest`, {
    headers: { Authorization: `Bearer ${lease}` }
  });
  if (!manifestResponse.ok) {
    throw new Error(`Manifest fetch failed with status ${manifestResponse.status}.`);
  }
  const manifestEnvelope = (await manifestResponse.json()) as { manifest?: RunnerManifest };
  if (!manifestEnvelope.manifest) throw new Error('Manifest response is missing manifest.');
  const manifest = manifestEnvelope.manifest;
  if (manifest.attemptId !== attemptId) throw new Error('Manifest Attempt does not match dispatch input.');

  let result: Record<string, unknown>;
  try {
    const output = await executeRegisteredCapability(manifest, env);
    result = { state: 'succeeded', output };
  } catch (error) {
    result = {
      state: 'failed',
      errorCode: 'RUNNER_CAPABILITY_FAILED',
      errorSummary: safeMessage(error)
    };
  }

  const callbackId = [
    'result',
    attemptId,
    env.GITHUB_RUN_ID || 'unknown-run',
    env.GITHUB_RUN_ATTEMPT || '1'
  ].join(':');
  const callbackResponse = await fetchImpl(`${baseUrl}/executor/callback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${lease}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      callbackId,
      kind: 'result',
      result
    })
  });
  if (!callbackResponse.ok) {
    throw new Error(`Result callback failed with status ${callbackResponse.status}.`);
  }

  if (result.state !== 'succeeded') {
    throw new Error(String(result.errorSummary ?? 'Registered capability failed.'));
  }
  return { claimed: true };
}

export async function executeRegisteredCapability(
  manifest: RunnerManifest,
  env: RunnerEnv = process.env
): Promise<Record<string, unknown>> {
  if (manifest.capability !== 'github.archive_markdown') {
    throw new Error(`Unregistered GitHub capability "${manifest.capability}".`);
  }
  const content = manifest.input.content;
  const sourceUrl = manifest.input.source_url;
  if (typeof content !== 'string' || typeof sourceUrl !== 'string') {
    throw new Error('github.archive_markdown requires string content and source_url.');
  }

  const bytes = new TextEncoder().encode(content);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const tempDir = env.RUNNER_TEMP || process.cwd();
  await writeFile(join(tempDir, 'archive.md'), content, 'utf8');

  return {
    artifact: {
      name: 'archive.md',
      mediaType: 'text/markdown',
      size: bytes.byteLength,
      sha256,
      sourceUrl
    }
  };
}

async function requestOidcToken(
  env: RunnerEnv,
  audience: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const requestUrl = required(env.ACTIONS_ID_TOKEN_REQUEST_URL, 'ACTIONS_ID_TOKEN_REQUEST_URL');
  const requestToken = required(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  const separator = requestUrl.includes('?') ? '&' : '?';
  const response = await fetchImpl(
    `${requestUrl}${separator}audience=${encodeURIComponent(audience)}`,
    { headers: { Authorization: `Bearer ${requestToken}` } }
  );
  if (!response.ok) throw new Error(`OIDC token request failed with status ${response.status}.`);
  const body = (await response.json()) as { value?: string };
  return required(body.value, 'OIDC token value');
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown runner error.').slice(0, 500);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  runExecutor().catch(error => {
    console.error(safeMessage(error));
    process.exitCode = 1;
  });
}
