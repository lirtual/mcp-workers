import type { RuntimePlan } from './runtime-plan.js';

export type RunState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'indeterminate';

export type StepRunState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped_condition'
  | 'skipped_dependency'
  | 'cancelled'
  | 'timed_out'
  | 'indeterminate';

export type AttemptState =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'timed_out'
  | 'indeterminate';

export interface StoredRun {
  runId: string;
  workflowId: string;
  definitionDigest: string;
  input: Record<string, unknown>;
  trigger: Record<string, unknown>;
  state: RunState;
  output?: Record<string, unknown>;
  errorCode?: string;
  errorSummary?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  cancelRequestedAt?: string;
}

export interface StoredDefinition {
  definitionDigest: string;
  workflowId: string;
  dslVersion: number;
  plan: RuntimePlan;
  sourcePath: string;
}

export interface AdmissionRequest {
  admissionKey: string;
  proposedRunId: string;
  workflowId: string;
  definitionDigest: string;
  input: Record<string, unknown>;
  trigger: Record<string, unknown>;
  sourceType: string;
  sourceKey?: string;
}

export interface AdmissionResult {
  runId: string;
  alreadyAdmitted: boolean;
}

export interface WorkflowEventRecord {
  eventId: number;
  eventType: string;
  stepRunId?: string;
  attemptId?: string;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface SchedulerState {
  scheduleKey: string;
  lastEvaluatedAt: number;
  lastAdmittedScheduledTime?: number;
  nextDueOccurrence?: number;
}

export interface StepSummary {
  stepRunId: string;
  stepId: string;
  operationId: string;
  state: StepRunState;
  output?: Record<string, unknown>;
  errorCode?: string;
  errorSummary?: string;
}

export interface RemoteAttemptRegistration {
  runId: string;
  stepRunId: string;
  stepId: string;
  attemptId: string;
  attemptNumber: number;
  claimNonceHash: string;
  expectedRepositoryId: string;
  expectedWorkflowRef: string;
  expectedRef: string;
  expectedWorkflowSha?: string;
  executionManifest: Record<string, unknown>;
}

export interface RemoteAttemptRecord {
  attemptId: string;
  stepRunId: string;
  runId: string;
  stepId: string;
  operationId: string;
  state: AttemptState;
  runState: RunState;
  claimNonceHash?: string;
  claimOwner?: string;
  githubRunId?: string;
  githubRunAttempt?: number;
  githubWorkflowSha?: string;
  expectedRepositoryId: string;
  expectedWorkflowRef: string;
  expectedRef: string;
  expectedWorkflowSha?: string;
  executionManifest: Record<string, unknown>;
}

export interface RemoteClaimInput {
  attemptId: string;
  claimNonceHash: string;
  claimOwner: string;
  claimDeadline: string;
  githubRunId: string;
  githubRunAttempt: number;
  githubWorkflowSha: string;
  expectedRepositoryId: string;
  expectedWorkflowRef: string;
  expectedRef: string;
}

export interface CallbackInboxInput {
  callbackId: string;
  attemptId: string;
  githubRunId: string;
  githubRunAttempt: number;
  callbackKind: string;
  result: Record<string, unknown>;
  ignoredReason?: string;
}

export interface CallbackInboxInsertResult {
  inserted: boolean;
}

export interface ExecutorDispatchRecordInput {
  attemptId: string;
  generation: number;
  outcome: 'accepted' | 'unknown' | 'failed';
  returnedGitHubRunId?: string;
  errorSummary?: string;
}

export interface ExecutorDispatchFact {
  generation: number;
  outcome: 'accepted' | 'unknown' | 'failed';
  returnedGitHubRunId?: string;
  dispatchedAt: string;
  errorSummary?: string;
}

export interface CallbackInboxRecord {
  callbackId: string;
  attemptId: string;
  githubRunId: string;
  githubRunAttempt: number;
  callbackKind: string;
  result: Record<string, unknown>;
  receivedAt: string;
  notificationAttemptCount?: number;
  nextNotificationAt?: string;
  notifiedAt?: string;
  ignoredReason?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export class D1WorkflowStore {
  constructor(private readonly db: D1Database) {}

  async ensureDefinition(input: {
    definitionDigest: string;
    workflowId: string;
    dslVersion: number;
    plan: unknown;
    sourcePath: string;
    sourceCommit?: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_definition_versions
         (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, source_commit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.definitionDigest,
        input.workflowId,
        input.dslVersion,
        JSON.stringify(input.plan),
        input.sourcePath,
        input.sourceCommit ?? null,
        nowIso()
      )
      .run();
  }

  async admitRun(input: AdmissionRequest): Promise<AdmissionResult> {
    const createdAt = nowIso();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO run_admissions
           (admission_key, run_id, workflow_id, source_type, source_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.admissionKey,
          input.proposedRunId,
          input.workflowId,
          input.sourceType,
          input.sourceKey ?? null,
          createdAt
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO workflow_runs
           (run_id, workflow_id, definition_digest, input_json, trigger_json, state,
            cf_workflow_instance_id, created_at)
           SELECT ?, ?, ?, ?, ?, 'queued', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM run_admissions
             WHERE admission_key = ? AND run_id = ?
           )`
        )
        .bind(
          input.proposedRunId,
          input.workflowId,
          input.definitionDigest,
          JSON.stringify(input.input),
          JSON.stringify(input.trigger),
          input.proposedRunId,
          createdAt,
          input.admissionKey,
          input.proposedRunId
        )
    ]);

    const admissionInserted = (results[0]?.meta.changes ?? 0) === 1;
    if (admissionInserted) {
      await this.appendEvent(input.proposedRunId, 'run.admitted', {
        workflowId: input.workflowId,
        definitionDigest: input.definitionDigest,
        sourceType: input.sourceType
      });
      return { runId: input.proposedRunId, alreadyAdmitted: false };
    }

    const existing = await this.db
      .prepare('SELECT run_id FROM run_admissions WHERE admission_key = ?')
      .bind(input.admissionKey)
      .first<{ run_id: string }>();
    if (!existing) throw new Error('Admission conflict could not be reconciled.');
    return { runId: existing.run_id, alreadyAdmitted: true };
  }

  async getRun(runId: string): Promise<StoredRun | null> {
    const row = await this.db
      .prepare(
        `SELECT run_id, workflow_id, definition_digest, input_json, trigger_json, state,
                output_json, error_code, error_summary, created_at, started_at, ended_at,
                cancel_requested_at
         FROM workflow_runs WHERE run_id = ?`
      )
      .bind(runId)
      .first<Record<string, string | null>>();
    if (!row) return null;

    return {
      runId: String(row.run_id),
      workflowId: String(row.workflow_id),
      definitionDigest: String(row.definition_digest),
      input: parseObject(row.input_json ?? null),
      trigger: parseObject(row.trigger_json ?? null),
      state: String(row.state) as RunState,
      ...(row.output_json ? { output: parseObject(row.output_json) } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
      createdAt: String(row.created_at),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      ...(row.cancel_requested_at ? { cancelRequestedAt: row.cancel_requested_at } : {})
    };
  }

  async getDefinition(definitionDigest: string): Promise<StoredDefinition | null> {
    const row = await this.db
      .prepare(
        `SELECT definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path
         FROM workflow_definition_versions WHERE definition_digest = ?`
      )
      .bind(definitionDigest)
      .first<Record<string, string | number>>();
    if (!row) return null;
    return {
      definitionDigest: String(row.definition_digest),
      workflowId: String(row.workflow_id),
      dslVersion: Number(row.dsl_version),
      plan: JSON.parse(String(row.normalized_plan_json)) as RuntimePlan,
      sourcePath: String(row.source_path)
    };
  }

  async markRunRunning(runId: string): Promise<void> {
    const startedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE workflow_runs
         SET state = 'running', started_at = COALESCE(started_at, ?)
         WHERE run_id = ? AND state = 'queued'`
      )
      .bind(startedAt, runId)
      .run();
    if ((result.meta.changes ?? 0) === 1) await this.appendEvent(runId, 'run.started', {});
  }

  async ensureStepRun(input: {
    runId: string;
    stepId: string;
    stepRunId: string;
    operationId: string;
    effectivePolicy: Record<string, unknown>;
  }): Promise<void> {
    const createdAt = nowIso();
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO step_runs
         (step_run_id, run_id, step_id, operation_id, state, effective_policy_json, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        input.stepRunId,
        input.runId,
        input.stepId,
        input.operationId,
        JSON.stringify(input.effectivePolicy),
        createdAt
      )
      .run();
    if ((result.meta.changes ?? 0) === 1) {
      await this.appendEvent(input.runId, 'step.created', { stepId: input.stepId }, input.stepRunId);
    }
  }

  async markStepSkipped(input: {
    runId: string;
    stepRunId: string;
    stepId: string;
    state: 'skipped_condition' | 'skipped_dependency';
  }): Promise<void> {
    const endedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE step_runs SET state = ?, ended_at = ?
         WHERE step_run_id = ? AND state = 'pending'`
      )
      .bind(input.state, endedAt, input.stepRunId)
      .run();
    if ((result.meta.changes ?? 0) === 1) {
      await this.appendEvent(input.runId, 'step.skipped', { stepId: input.stepId, state: input.state }, input.stepRunId);
    }
  }

  async ensureAttempt(input: {
    runId: string;
    stepRunId: string;
    stepId: string;
    attemptId: string;
    attemptNumber: number;
    executorType: string;
  }): Promise<boolean> {
    const startedAt = nowIso();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE step_runs
           SET state = 'running', started_at = COALESCE(started_at, ?)
           WHERE step_run_id = ?
             AND state = 'pending'
             AND EXISTS (
               SELECT 1 FROM workflow_runs wr
               WHERE wr.run_id = step_runs.run_id
                 AND wr.state IN ('queued', 'running', 'waiting')
                 AND wr.cancel_requested_at IS NULL
             )`
        )
        .bind(startedAt, input.stepRunId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO step_attempts
           (attempt_id, step_run_id, attempt_number, executor_type, state, created_at, started_at)
           SELECT ?, ?, ?, ?, 'running', ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM step_runs sr
             JOIN workflow_runs wr ON wr.run_id = sr.run_id
             WHERE sr.step_run_id = ?
               AND sr.run_id = ?
               AND wr.state IN ('queued', 'running', 'waiting')
               AND wr.cancel_requested_at IS NULL
           )`
        )
        .bind(
          input.attemptId,
          input.stepRunId,
          input.attemptNumber,
          input.executorType,
          startedAt,
          startedAt,
          input.stepRunId,
          input.runId
        )
    ]);
    const authorized = (results[1]?.meta.changes ?? 0) === 1;
    if (authorized) {
      await this.appendEvent(
        input.runId,
        'attempt.started',
        { stepId: input.stepId, attemptNumber: input.attemptNumber },
        input.stepRunId,
        input.attemptId
      );
    }
    return authorized;
  }

  async recordAttemptDependencySnapshot(
    attemptId: string,
    snapshot: Record<string, unknown>
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE step_attempts
         SET dependency_snapshot_json = ?
         WHERE attempt_id = ?`
      )
      .bind(JSON.stringify(snapshot), attemptId)
      .run();
  }

  async recordAttemptResult(input: {
    runId: string;
    stepRunId: string;
    stepId: string;
    attemptId: string;
    state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'indeterminate';
    output?: Record<string, unknown>;
    errorCode?: string;
    errorSummary?: string;
    dependencySnapshot?: Record<string, unknown>;
  }): Promise<void> {
    const endedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE step_attempts
         SET state = ?, terminal_result_json = ?, error_code = ?, error_summary = ?,
             dependency_snapshot_json = ?, ended_at = ?
         WHERE attempt_id = ? AND state IN ('queued', 'claimed', 'running', 'cancel_requested')`
      )
      .bind(
        input.state,
        input.output ? JSON.stringify(input.output) : null,
        input.errorCode ?? null,
        input.errorSummary ?? null,
        input.dependencySnapshot ? JSON.stringify(input.dependencySnapshot) : null,
        endedAt,
        input.attemptId
      )
      .run();
    if ((result.meta.changes ?? 0) === 1) {
      await this.appendEvent(
        input.runId,
        `attempt.${input.state}`,
        {
          stepId: input.stepId,
          ...(input.errorCode ? { code: input.errorCode } : {})
        },
        input.stepRunId,
        input.attemptId
      );
    }
  }

  async finishStep(input: {
    runId: string;
    stepRunId: string;
    stepId: string;
    state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'indeterminate';
    output?: Record<string, unknown>;
    errorCode?: string;
    errorSummary?: string;
  }): Promise<void> {
    const endedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE step_runs
         SET state = ?, output_json = ?, error_code = ?, error_summary = ?, ended_at = ?
         WHERE step_run_id = ? AND state IN ('pending', 'running', 'cancelled')`
      )
      .bind(
        input.state,
        input.output ? JSON.stringify(input.output) : null,
        input.errorCode ?? null,
        input.errorSummary ?? null,
        endedAt,
        input.stepRunId
      )
      .run();
    if ((result.meta.changes ?? 0) === 1) {
      await this.appendEvent(
        input.runId,
        `step.${input.state}`,
        {
          stepId: input.stepId,
          ...(input.errorCode ? { code: input.errorCode } : {})
        },
        input.stepRunId
      );
    }
  }

  async finishRun(input: {
    runId: string;
    state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'indeterminate';
    output: Record<string, unknown>;
    errorCode?: string;
    errorSummary?: string;
  }): Promise<void> {
    const endedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE workflow_runs
         SET state = ?, output_json = ?, error_code = ?, error_summary = ?, ended_at = ?
         WHERE run_id = ? AND state IN ('queued', 'running', 'waiting', 'cancel_requested')`
      )
      .bind(
        input.state,
        JSON.stringify(input.output),
        input.errorCode ?? null,
        input.errorSummary ?? null,
        endedAt,
        input.runId
      )
      .run();
    if ((result.meta.changes ?? 0) === 1) {
      await this.appendEvent(
        input.runId,
        `run.${input.state}`,
        input.errorCode ? { code: input.errorCode } : {}
      );
    }
  }

  async requestRunCancellation(runId: string): Promise<StoredRun | null> {
    const requestedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE workflow_runs
         SET state = 'cancel_requested',
             cancel_requested_at = COALESCE(cancel_requested_at, ?)
         WHERE run_id = ?
           AND state IN ('queued', 'running', 'waiting')
           AND cancel_requested_at IS NULL`
      )
      .bind(requestedAt, runId)
      .run();

    if ((result.meta.changes ?? 0) === 1) {
      await this.appendEvent(runId, 'run.cancel_requested', {});
    }
    return this.getRun(runId);
  }

  async listActiveRemoteAttemptsForRun(runId: string): Promise<RemoteAttemptRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT sa.attempt_id
         FROM step_attempts sa
         JOIN step_runs sr ON sr.step_run_id = sa.step_run_id
         WHERE sr.run_id = ?
           AND sa.executor_type = 'github'
           AND sa.state IN ('queued', 'claimed', 'running', 'cancel_requested')
         ORDER BY sa.created_at ASC, sa.attempt_number ASC`
      )
      .bind(runId)
      .all<{ attempt_id: string }>();

    const attempts: RemoteAttemptRecord[] = [];
    for (const row of result.results) {
      const attempt = await this.getRemoteAttempt(row.attempt_id);
      if (attempt) attempts.push(attempt);
    }
    return attempts;
  }

  async markRemoteAttemptCancelRequested(attemptId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE step_attempts
         SET state = CASE
           WHEN state IN ('claimed', 'running') THEN 'cancel_requested'
           ELSE state
         END
         WHERE attempt_id = ?
           AND executor_type = 'github'
           AND state IN ('queued', 'claimed', 'running', 'cancel_requested')`
      )
      .bind(attemptId)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async listCancellationWakeAttempts(limit: number): Promise<RemoteAttemptRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT sa.attempt_id
         FROM step_attempts sa
         JOIN step_runs sr ON sr.step_run_id = sa.step_run_id
         JOIN workflow_runs wr ON wr.run_id = sr.run_id
         WHERE wr.state = 'cancel_requested'
           AND wr.cancel_requested_at IS NOT NULL
           AND sa.executor_type = 'github'
           AND sa.state IN ('queued', 'claimed', 'running', 'cancel_requested')
         ORDER BY wr.cancel_requested_at ASC, sa.created_at ASC
         LIMIT ?`
      )
      .bind(limit)
      .all<{ attempt_id: string }>();

    const attempts: RemoteAttemptRecord[] = [];
    for (const row of result.results) {
      const attempt = await this.getRemoteAttempt(row.attempt_id);
      if (attempt) attempts.push(attempt);
    }
    return attempts;
  }

  async getStepRunPolicy(stepRunId: string): Promise<Record<string, unknown> | null> {
    const row = await this.db
      .prepare('SELECT effective_policy_json FROM step_runs WHERE step_run_id = ?')
      .bind(stepRunId)
      .first<{ effective_policy_json: string | null }>();
    if (!row?.effective_policy_json) return null;
    return parseObject(row.effective_policy_json);
  }

  async registerRemoteAttempt(input: RemoteAttemptRegistration): Promise<void> {
    const createdAt = nowIso();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE step_runs
           SET state = 'running', started_at = COALESCE(started_at, ?)
           WHERE step_run_id = ? AND run_id = ? AND state IN ('pending', 'running')`
        )
        .bind(createdAt, input.stepRunId, input.runId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO step_attempts
           (attempt_id, step_run_id, attempt_number, executor_type, state,
            claim_nonce_hash, expected_repository_id, expected_workflow_ref,
            expected_ref, expected_workflow_sha, execution_manifest_json, created_at)
           SELECT ?, ?, ?, 'github', 'queued', ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM step_runs sr
             JOIN workflow_runs wr ON wr.run_id = sr.run_id
             WHERE sr.step_run_id = ? AND sr.run_id = ?
               AND wr.state IN ('queued', 'running', 'waiting')
               AND wr.cancel_requested_at IS NULL
           )`
        )
        .bind(
          input.attemptId,
          input.stepRunId,
          input.attemptNumber,
          input.claimNonceHash,
          input.expectedRepositoryId,
          input.expectedWorkflowRef,
          input.expectedRef,
          input.expectedWorkflowSha ?? null,
          JSON.stringify(input.executionManifest),
          createdAt,
          input.stepRunId,
          input.runId
        )
    ]);

    if ((results[1]?.meta.changes ?? 0) === 1) {
      await this.appendEvent(
        input.runId,
        'attempt.queued',
        { stepId: input.stepId, attemptNumber: input.attemptNumber, executor: 'github' },
        input.stepRunId,
        input.attemptId
      );
    }
  }

  async getRemoteAttempt(attemptId: string): Promise<RemoteAttemptRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT
           sa.attempt_id, sa.step_run_id, sa.state, sa.claim_nonce_hash, sa.claim_owner,
           sa.github_run_id, sa.github_run_attempt, sa.github_workflow_sha,
           sa.expected_repository_id, sa.expected_workflow_ref, sa.expected_ref,
           sa.expected_workflow_sha, sa.execution_manifest_json,
           sr.run_id, sr.step_id, sr.operation_id,
           wr.state AS run_state
         FROM step_attempts sa
         JOIN step_runs sr ON sr.step_run_id = sa.step_run_id
         JOIN workflow_runs wr ON wr.run_id = sr.run_id
         WHERE sa.attempt_id = ? AND sa.executor_type = 'github'`
      )
      .bind(attemptId)
      .first<Record<string, string | number | null>>();
    if (!row) return null;

    return {
      attemptId: String(row.attempt_id),
      stepRunId: String(row.step_run_id),
      runId: String(row.run_id),
      stepId: String(row.step_id),
      operationId: String(row.operation_id),
      state: String(row.state) as AttemptState,
      runState: String(row.run_state) as RunState,
      ...(row.claim_nonce_hash ? { claimNonceHash: String(row.claim_nonce_hash) } : {}),
      ...(row.claim_owner ? { claimOwner: String(row.claim_owner) } : {}),
      ...(row.github_run_id ? { githubRunId: String(row.github_run_id) } : {}),
      ...(row.github_run_attempt === null ? {} : { githubRunAttempt: Number(row.github_run_attempt) }),
      ...(row.github_workflow_sha ? { githubWorkflowSha: String(row.github_workflow_sha) } : {}),
      expectedRepositoryId: String(row.expected_repository_id),
      expectedWorkflowRef: String(row.expected_workflow_ref),
      expectedRef: String(row.expected_ref),
      ...(row.expected_workflow_sha ? { expectedWorkflowSha: String(row.expected_workflow_sha) } : {}),
      executionManifest: parseObject(
        row.execution_manifest_json === null ? null : String(row.execution_manifest_json)
      )
    };
  }

  async claimRemoteAttempt(input: RemoteClaimInput): Promise<boolean> {
    const claimedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE step_attempts
         SET state = 'claimed',
             claim_owner = ?,
             claimed_at = ?,
             claim_deadline = ?,
             github_run_id = ?,
             github_run_attempt = ?,
             github_workflow_sha = ?
         WHERE attempt_id = ?
           AND executor_type = 'github'
           AND state = 'queued'
           AND claim_nonce_hash = ?
           AND github_run_id IS NULL
           AND expected_repository_id = ?
           AND expected_workflow_ref = ?
           AND expected_ref = ?
           AND (expected_workflow_sha IS NULL OR expected_workflow_sha = ?)
           AND EXISTS (
             SELECT 1
             FROM step_runs sr
             JOIN workflow_runs wr ON wr.run_id = sr.run_id
             WHERE sr.step_run_id = step_attempts.step_run_id
               AND wr.state IN ('queued', 'running', 'waiting')
               AND wr.cancel_requested_at IS NULL
           )`
      )
      .bind(
        input.claimOwner,
        claimedAt,
        input.claimDeadline,
        input.githubRunId,
        input.githubRunAttempt,
        input.githubWorkflowSha,
        input.attemptId,
        input.claimNonceHash,
        input.expectedRepositoryId,
        input.expectedWorkflowRef,
        input.expectedRef,
        input.githubWorkflowSha
      )
      .run();

    return (result.meta.changes ?? 0) === 1;
  }

  async insertCallbackInbox(input: CallbackInboxInput): Promise<CallbackInboxInsertResult> {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO callback_inbox
         (callback_id, attempt_id, github_run_id, github_run_attempt,
          callback_kind, result_json, received_at, ignored_reason)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM step_attempts
           WHERE attempt_id = ?
             AND github_run_id = ?
             AND github_run_attempt = ?
         )`
      )
      .bind(
        input.callbackId,
        input.attemptId,
        input.githubRunId,
        input.githubRunAttempt,
        input.callbackKind,
        JSON.stringify(input.result),
        nowIso(),
        input.ignoredReason ?? null,
        input.attemptId,
        input.githubRunId,
        input.githubRunAttempt
      )
      .run();
    return { inserted: (result.meta.changes ?? 0) === 1 };
  }

  async recordExecutorDispatch(input: ExecutorDispatchRecordInput): Promise<void> {
    const dispatchedAt = nowIso();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE step_attempts
           SET dispatch_generation = CASE
             WHEN dispatch_generation < ? THEN ?
             ELSE dispatch_generation
           END
           WHERE attempt_id = ? AND executor_type = 'github'`
        )
        .bind(input.generation, input.generation, input.attemptId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO executor_dispatches
           (attempt_id, generation, dispatched_at, outcome, returned_github_run_id, error_summary)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.attemptId,
          input.generation,
          dispatchedAt,
          input.outcome,
          input.returnedGitHubRunId ?? null,
          input.errorSummary ?? null
        )
    ]);
  }

  async getCallbackInbox(callbackId: string): Promise<CallbackInboxRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT callback_id, attempt_id, github_run_id, github_run_attempt,
                callback_kind, result_json, received_at, notification_attempt_count,
                next_notification_at, notified_at, ignored_reason
         FROM callback_inbox WHERE callback_id = ?`
      )
      .bind(callbackId)
      .first<Record<string, string | number | null>>();
    if (!row) return null;

    return {
      callbackId: String(row.callback_id),
      attemptId: String(row.attempt_id),
      githubRunId: String(row.github_run_id),
      githubRunAttempt: Number(row.github_run_attempt),
      callbackKind: String(row.callback_kind),
      result: parseObject(row.result_json === null ? null : String(row.result_json)),
      receivedAt: String(row.received_at),
      notificationAttemptCount: Number(row.notification_attempt_count ?? 0),
      ...(row.next_notification_at ? { nextNotificationAt: String(row.next_notification_at) } : {}),
      ...(row.notified_at ? { notifiedAt: String(row.notified_at) } : {}),
      ...(row.ignored_reason ? { ignoredReason: String(row.ignored_reason) } : {})
    };
  }

  async listExecutorDispatches(attemptId: string): Promise<ExecutorDispatchFact[]> {
    const result = await this.db
      .prepare(
        `SELECT generation, outcome, returned_github_run_id, dispatched_at, error_summary
         FROM executor_dispatches
         WHERE attempt_id = ?
         ORDER BY generation ASC`
      )
      .bind(attemptId)
      .all<Record<string, string | number | null>>();

    return result.results.map(row => ({
      generation: Number(row.generation),
      outcome: String(row.outcome) as ExecutorDispatchFact['outcome'],
      ...(row.returned_github_run_id
        ? { returnedGitHubRunId: String(row.returned_github_run_id) }
        : {}),
      dispatchedAt: String(row.dispatched_at),
      ...(row.error_summary ? { errorSummary: String(row.error_summary) } : {})
    }));
  }

  async getLatestCallbackForAttempt(attemptId: string): Promise<CallbackInboxRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT callback_id FROM callback_inbox
         WHERE attempt_id = ? AND callback_kind = 'result'
         ORDER BY received_at DESC LIMIT 1`
      )
      .bind(attemptId)
      .first<{ callback_id: string }>();
    return row ? this.getCallbackInbox(row.callback_id) : null;
  }

  async listDueCallbackNotifications(
    now: string,
    limit: number,
    maxAttempts: number
  ): Promise<CallbackInboxRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT callback_id FROM callback_inbox
         WHERE notified_at IS NULL
           AND ignored_reason IS NULL
           AND notification_attempt_count < ?
           AND (next_notification_at IS NULL OR next_notification_at <= ?)
         ORDER BY received_at ASC
         LIMIT ?`
      )
      .bind(maxAttempts, now, limit)
      .all<{ callback_id: string }>();

    const rows: CallbackInboxRecord[] = [];
    for (const row of result.results) {
      const callback = await this.getCallbackInbox(row.callback_id);
      if (callback) rows.push(callback);
    }
    return rows;
  }

  async markCallbackIgnored(callbackId: string, reason: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE callback_inbox
         SET ignored_reason = ?, next_notification_at = NULL
         WHERE callback_id = ? AND notified_at IS NULL`
      )
      .bind(reason.slice(0, 200), callbackId)
      .run();
  }

  async markCallbackNotified(callbackId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE callback_inbox
         SET notified_at = ?, notification_attempt_count = notification_attempt_count + 1,
             next_notification_at = NULL
         WHERE callback_id = ?`
      )
      .bind(nowIso(), callbackId)
      .run();
  }

  async recordCallbackNotificationFailure(
    callbackId: string,
    nextNotificationAt: string
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE callback_inbox
         SET notification_attempt_count = notification_attempt_count + 1,
             next_notification_at = ?
         WHERE callback_id = ? AND notified_at IS NULL`
      )
      .bind(nextNotificationAt, callbackId)
      .run();
  }

  async getSchedulerState(scheduleKey: string): Promise<SchedulerState | null> {
    const row = await this.db
      .prepare(
        `SELECT schedule_key, last_evaluated_at, last_admitted_scheduled_time, next_due_occurrence
         FROM scheduler_state WHERE schedule_key = ?`
      )
      .bind(scheduleKey)
      .first<Record<string, string | number | null>>();
    if (!row) return null;

    return {
      scheduleKey: String(row.schedule_key),
      lastEvaluatedAt: Number(row.last_evaluated_at),
      ...(row.last_admitted_scheduled_time === null
        ? {}
        : { lastAdmittedScheduledTime: Number(row.last_admitted_scheduled_time) }),
      ...(row.next_due_occurrence === null
        ? {}
        : { nextDueOccurrence: Number(row.next_due_occurrence) })
    };
  }

  async saveSchedulerState(input: SchedulerState): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO scheduler_state
         (schedule_key, last_evaluated_at, last_admitted_scheduled_time, next_due_occurrence)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(schedule_key) DO UPDATE SET
           last_evaluated_at = excluded.last_evaluated_at,
           last_admitted_scheduled_time = excluded.last_admitted_scheduled_time,
           next_due_occurrence = excluded.next_due_occurrence`
      )
      .bind(
        input.scheduleKey,
        input.lastEvaluatedAt,
        input.lastAdmittedScheduledTime ?? null,
        input.nextDueOccurrence ?? null
      )
      .run();
  }

  async listStepSummaries(runId: string): Promise<StepSummary[]> {
    const result = await this.db
      .prepare(
        `SELECT step_run_id, step_id, operation_id, state, output_json, error_code, error_summary
         FROM step_runs WHERE run_id = ? ORDER BY created_at, step_id`
      )
      .bind(runId)
      .all<Record<string, string | null>>();

    return result.results.map(row => ({
      stepRunId: String(row.step_run_id),
      stepId: String(row.step_id),
      operationId: String(row.operation_id),
      state: String(row.state) as StepRunState,
      ...(row.output_json ? { output: parseObject(row.output_json) } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_summary ? { errorSummary: row.error_summary } : {})
    }));
  }

  async listEvents(runId: string, afterEventId: number, limit: number): Promise<WorkflowEventRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT event_id, step_run_id, attempt_id, event_type, summary_json, created_at
         FROM workflow_events
         WHERE run_id = ? AND event_id > ?
         ORDER BY event_id ASC LIMIT ?`
      )
      .bind(runId, afterEventId, limit)
      .all<Record<string, string | number | null>>();

    return result.results.map(row => ({
      eventId: Number(row.event_id),
      eventType: String(row.event_type),
      ...(row.step_run_id ? { stepRunId: String(row.step_run_id) } : {}),
      ...(row.attempt_id ? { attemptId: String(row.attempt_id) } : {}),
      summary: parseObject(row.summary_json === null ? null : String(row.summary_json)),
      createdAt: String(row.created_at)
    }));
  }

  private async appendEvent(
    runId: string,
    eventType: string,
    summary: Record<string, unknown>,
    stepRunId?: string,
    attemptId?: string
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO workflow_events
         (run_id, step_run_id, attempt_id, event_type, summary_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        runId,
        stepRunId ?? null,
        attemptId ?? null,
        eventType,
        JSON.stringify(summary),
        nowIso()
      )
      .run();
  }
}
