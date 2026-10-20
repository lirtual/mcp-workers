import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ActionError, GitHubActionsClient } from './github.ts';
import type { Env } from './github.ts';

const repo = z.string().min(3).max(150);
const runId = z.number().int().positive();
const workflow = z.string().min(1).max(128);
const inputValues = z.record(z.string(), z.string()).refine(
  (v) => Object.keys(v).length <= 25 && Object.entries(v).every(([k, val]) =>
    k.length <= 100 && val.length <= 1000), 'inputs_too_large',
);
const annotationsRead = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const annotationsWrite = { readOnlyHint: false, idempotentHint: false, openWorldHint: true };

function reply(value: unknown) {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 96 * 1024) {
    return { isError: true, content: [{ type: 'text' as const, text: '{"error":"result_too_large"}' }] };
  }
  return { content: [{ type: 'text' as const, text: serialized }] };
}

function failure(error: unknown) {
  // Never expose request data, tokens, upstream error bodies, or stack traces.
  const code = error instanceof ActionError ? error.code : 'upstream_unavailable';
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] };
}

async function safe(work: () => Promise<unknown>) {
  try { return reply(await work()); } catch (error) { return failure(error); }
}

export function buildMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: 'github-actions-mcp-worker', version: '0.1.0' },
    { capabilities: { tools: {} },
      instructions: 'Operate GitHub Actions only in the configured, credential-isolated repository allowlists. Never route requests to a different GitHub account credential if the assigned token fails. Dispatch, cancellation, and rerun are effectful. Use run_get before canceling. run_cancel and run_force_cancel only acknowledge cancellation requests, never confirm a run stopped; check run_get for status=completed and conclusion=cancelled. Use run_force_cancel only when normal cancellation fails to stop a run; force cancellation can bypass cleanup. Use workflow_dispatch with an explicit ref. Workflows such as tsrv and tsvc are regular Actions workflows, not special session APIs.' },
  );
  const api = new GitHubActionsClient(env);

  server.registerTool('repositories_list', {
    description: 'List the explicitly allowed repositories. No GitHub discovery or arbitrary repository access.',
    inputSchema: z.object({}).strict(), annotations: annotationsRead,
  }, async () => reply({ repositories: api.allowlist }));

  server.registerTool('workflows_list', {
    description: 'List GitHub Actions workflows and their enabled/disabled states in one allowed repository.',
    inputSchema: z.object({ repo }).strict(), annotations: annotationsRead,
  }, async ({ repo }) => safe(() => api.listWorkflows(repo)));

  server.registerTool('runs_list', {
    description: 'List up to 30 recent workflow runs, optionally filtered by workflow file and status.',
    inputSchema: z.object({
      repo, workflow: workflow.optional(),
      status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending', 'success', 'failure', 'cancelled']).optional(),
    }).strict(),
    annotations: annotationsRead,
  }, async ({ repo, status, workflow }) => safe(() => api.listRuns(repo, status, workflow)));

  server.registerTool('run_get', {
    description: 'Get status, conclusion, source event and GitHub URL of a workflow run.',
    inputSchema: z.object({ repo, run_id: runId }).strict(), annotations: annotationsRead,
  }, async ({ repo, run_id }) => safe(() => api.getRun(repo, run_id)));

  server.registerTool('run_jobs_list', {
    description: 'List workflow jobs and individual step outcomes without downloading potentially sensitive logs.',
    inputSchema: z.object({ repo, run_id: runId }).strict(), annotations: annotationsRead,
  }, async ({ repo, run_id }) => safe(() => api.listJobs(repo, run_id)));

  server.registerTool('run_artifacts_list', {
    description: 'List run artifacts metadata only. Does not download potentially sensitive artifact bodies.',
    inputSchema: z.object({ repo, run_id: runId }).strict(), annotations: annotationsRead,
  }, async ({ repo, run_id }) => safe(() => api.listArtifacts(repo, run_id)));

  server.registerTool('workflow_dispatch', {
    description: 'Trigger a workflow_dispatch workflow by file name or numeric ID on an explicit branch or tag; this starts a real GitHub Actions run.',
    inputSchema: z.object({
      repo, workflow, ref: z.string().min(1).max(200), inputs: inputValues.optional(),
    }).strict(),
    annotations: annotationsWrite,
  }, async ({ repo, workflow, ref, inputs }) => safe(() => api.dispatchWorkflow(repo, workflow, ref, inputs ?? {})));

  server.registerTool('repository_dispatch', {
    description: 'Emit a repository_dispatch event in an allowed repository. Only workflows subscribed to the event run; the event uses the default branch.',
    inputSchema: z.object({
      repo, event_type: z.string().min(1).max(100),
      client_payload: z.record(z.string(), z.unknown()).optional(),
    }).strict(), annotations: annotationsWrite,
  }, async ({ repo, event_type, client_payload }) => safe(() => {
    const payload = client_payload ?? {};
    if (Object.keys(payload).length > 10 || JSON.stringify(payload).length > 8192)
      throw new ActionError('payload_too_large');
    return api.dispatchRepository(repo, event_type, payload);
  }));

  server.registerTool('run_cancel', {
    description: 'Request cancellation of one run. Requires confirm=true. Accepted only means GitHub received the request; verify completion with run_get (status=completed, conclusion=cancelled).',
    inputSchema: z.object({ repo, run_id: runId, confirm: z.literal(true) }).strict(),
    annotations: { ...annotationsWrite, destructiveHint: true },
  }, async ({ repo, run_id }) => safe(() => api.cancelRun(repo, run_id)));

  server.registerTool('run_force_cancel', {
    description: 'Force cancellation of one unresponsive run, bypassing conditions that may prevent normal cancellation (including cleanup). Use only after run_cancel has failed to stop it. Requires explicit confirm=true; verify completion with run_get.',
    inputSchema: z.object({ repo, run_id: runId, confirm: z.literal(true) }).strict(),
    annotations: { ...annotationsWrite, destructiveHint: true },
  }, async ({ repo, run_id }) => safe(() => api.forceCancelRun(repo, run_id)));

  server.registerTool('run_rerun', {
    description: 'Retry a workflow run, either all jobs or only failed jobs. Starts execution and may incur GitHub Actions usage.',
    inputSchema: z.object({ repo, run_id: runId, mode: z.enum(['all', 'failed']) }).strict(),
    annotations: annotationsWrite,
  }, async ({ repo, run_id, mode }) => safe(() => api.rerunRun(repo, run_id, mode === 'failed')));

  return server;
}
