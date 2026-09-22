import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { prepareCatalogActivation, prepareCatalogPublication } from '../src/catalog-publication.js';
import { validateCatalogPublisherTarget, type CatalogPublisherMode } from '../src/catalog-publisher-target.js';

const sha = /^[0-9a-f]{40}$/;
const positiveId = /^[1-9][0-9]*$/;
const sourcePath = /^workflows\/[A-Za-z][A-Za-z0-9_-]{0,127}\.ya?ml$/;

const policySchema = z.object({
  revision: z.number().int().positive(),
  connections: z.record(z.string(), z.object({
    tools: z.record(z.string(), z.object({
      effect: z.enum(['read', 'idempotent_write', 'unsafe_write', 'unknown']),
      operationIdArgument: z.string().optional()
    }).strict()),
    version: z.number().int().positive().optional(),
    enabled: z.boolean().optional()
  }).strict()),
  webhookBindings: z.array(z.object({
    workflowId: z.string(), triggerId: z.string(), referenceId: z.string()
  }).strict()).max(64).optional()
}).strict();


function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() !== value) throw new Error('Missing or malformed ' + name);
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > 320 * 1024) {
    throw new Error('Publisher response exceeds the size limit.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch { throw new Error('Publisher endpoint returned non-JSON.'); }
  if (!response.ok) {
    const value = parsed as { error?: unknown };
    const code = typeof value?.error === 'string' ? value.error : 'remote_error';
    throw new Error('Publisher endpoint HTTP ' + response.status + ': ' + code);
  }
  return parsed;
}

async function run(): Promise<void> {
  const env = process.env;
  const mode = (env.WORKFLOW_CATALOG_MODE || 'dry-run') as CatalogPublisherMode;
  if (!['dry-run', 'stage', 'activate'].includes(mode)) throw new Error('Invalid publisher mode.');
  const endpoint = validateCatalogPublisherTarget(
    requireValue(env, 'WORKFLOW_MCP_TARGET_URL'),
    mode,
    {
      allowLiveTarget: env.WORKFLOW_MCP_ALLOW_LIVE_TEST_TARGET,
      allowLiveMutations: env.WORKFLOW_MCP_ALLOW_LIVE_TEST_MUTATIONS
    }
  );
  const expectedRepository = requireValue(env, 'WORKFLOW_CATALOG_REPOSITORY');
  const expectedRepositoryId = requireValue(env, 'WORKFLOW_CATALOG_REPOSITORY_ID');
  const checkedRepository = requireValue(env, 'CATALOG_CHECKED_REPOSITORY');
  const checkedRepositoryId = requireValue(env, 'CATALOG_CHECKED_REPOSITORY_ID');
  const requestedSha = requireValue(env, 'CATALOG_REQUESTED_SHA');
  const checkedOutSha = requireValue(env, 'CATALOG_CHECKED_OUT_SHA');
  const selectedPath = requireValue(env, 'CATALOG_SOURCE_PATH');
  if (!sha.test(requestedSha) || !sourcePath.test(selectedPath) ||
      !positiveId.test(expectedRepositoryId) || !positiveId.test(checkedRepositoryId)) {
    throw new Error('Catalog commit, source path or repository identity is invalid.');
  }
  const checkout = await realpath(requireValue(env, 'CATALOG_CHECKOUT_DIR'));
  const candidate = path.join(checkout, selectedPath);
  const candidateInfo = await lstat(candidate);
  const resolved = await realpath(candidate);
  if (!candidateInfo.isFile() || !resolved.startsWith(checkout + path.sep) ||
      candidateInfo.size > 320 * 1024) {
    throw new Error('Only a bounded regular YAML file inside the catalog is permitted.');
  }
  const yaml = await readFile(resolved, 'utf8');

  const requestUrl = new URL(requireValue(env, 'ACTIONS_ID_TOKEN_REQUEST_URL'));
  requestUrl.searchParams.set('audience', 'workflow-mcp-publisher');
  const requestedToken = await boundedJson(await fetch(requestUrl, {
    headers: { Authorization: 'Bearer ' + requireValue(env, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN') }
  }));
  const idToken = (requestedToken as { value?: unknown }).value;
  if (typeof idToken !== 'string' || !idToken) throw new Error('GitHub OIDC token unavailable.');

  const headers = { authorization: 'Bearer ' + idToken, 'content-type': 'application/json' };
  const snapshot = await boundedJson(await fetch(new URL('/admin/connections/snapshot', endpoint), {
    headers: { authorization: headers.authorization }, redirect: 'error'
  }));
  const policy = policySchema.parse(snapshot);
  const staged = prepareCatalogPublication({
    repository: checkedRepository,
    repositoryId: checkedRepositoryId,
    expectedRepository, expectedRepositoryId,
    requestedSha, checkedOutSha,
    publisherRunId: requireValue(env, 'GITHUB_RUN_ID'),
    publisherRunAttempt: Number(requireValue(env, 'GITHUB_RUN_ATTEMPT')),
    sourcePath: selectedPath, yaml, policy
  });
  if (mode === 'dry-run') {
    console.log(JSON.stringify({
      mode, workflowId: staged.workflowId, definitionDigest: staged.definitionDigest,
      sourceSha: staged.sourceSha, policyRevision: staged.policyRevision
    }));
    return;
  }
  await boundedJson(await fetch(new URL('/admin/definitions/stage', endpoint), {
    method: 'POST', headers, redirect: 'error', body: JSON.stringify(staged)
  }));
  if (mode === 'activate') {
    const revision = Number(requireValue(env, 'PUBLISHER_EXPECTED_REVISION'));
    const expectedDigest = env.PUBLISHER_EXPECTED_DIGEST || null;
    const activation = prepareCatalogActivation(staged, {
      activeDigest: expectedDigest, revision
    });
    await boundedJson(await fetch(new URL('/admin/definitions/activate', endpoint), {
      method: 'POST', headers, redirect: 'error', body: JSON.stringify(activation)
    }));
  }
  console.log(JSON.stringify({
    mode, workflowId: staged.workflowId, definitionDigest: staged.definitionDigest,
    sourceSha: staged.sourceSha, policyRevision: staged.policyRevision
  }));
}

await run().catch(error => {
  console.error(error instanceof Error ? error.message : 'Catalog publisher failed.');
  process.exitCode = 1;
});
