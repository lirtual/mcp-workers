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

export interface StepSummary {
  stepRunId: string;
  stepId: string;
  operationId: string;
  state: StepRunState;
  output?: Record<string, unknown>;
  errorCode?: string;
  errorSummary?: string;
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
                output_json, error_code, error_summary, created_at, started_at, ended_at
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
      ...(row.ended_at ? { endedAt: row.ended_at } : {})
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
  }): Promise<void> {
    const startedAt = nowIso();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE step_runs
           SET state = 'running', started_at = COALESCE(started_at, ?)
           WHERE step_run_id = ? AND state = 'pending'`
        )
        .bind(startedAt, input.stepRunId),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO step_attempts
           (attempt_id, step_run_id, attempt_number, executor_type, state, created_at, started_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`
        )
        .bind(
          input.attemptId,
          input.stepRunId,
          input.attemptNumber,
          input.executorType,
          startedAt,
          startedAt
        )
    ]);
    if ((results[1]?.meta.changes ?? 0) === 1) {
      await this.appendEvent(
        input.runId,
        'attempt.started',
        { stepId: input.stepId, attemptNumber: input.attemptNumber },
        input.stepRunId,
        input.attemptId
      );
    }
  }

  async recordAttemptResult(input: {
    runId: string;
    stepRunId: string;
    stepId: string;
    attemptId: string;
    state: 'succeeded' | 'failed' | 'timed_out' | 'indeterminate';
    output?: Record<string, unknown>;
    errorCode?: string;
    errorSummary?: string;
  }): Promise<void> {
    const endedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE step_attempts
         SET state = ?, terminal_result_json = ?, error_code = ?, error_summary = ?, ended_at = ?
         WHERE attempt_id = ? AND state = 'running'`
      )
      .bind(
        input.state,
        input.output ? JSON.stringify(input.output) : null,
        input.errorCode ?? null,
        input.errorSummary ?? null,
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
    state: 'succeeded' | 'failed' | 'timed_out' | 'indeterminate';
    output?: Record<string, unknown>;
    errorCode?: string;
    errorSummary?: string;
  }): Promise<void> {
    const endedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE step_runs
         SET state = ?, output_json = ?, error_code = ?, error_summary = ?, ended_at = ?
         WHERE step_run_id = ? AND state IN ('pending', 'running')`
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
    state: 'succeeded' | 'failed' | 'timed_out' | 'indeterminate';
    output: Record<string, unknown>;
    errorCode?: string;
    errorSummary?: string;
  }): Promise<void> {
    const endedAt = nowIso();
    const result = await this.db
      .prepare(
        `UPDATE workflow_runs
         SET state = ?, output_json = ?, error_code = ?, error_summary = ?, ended_at = ?
         WHERE run_id = ? AND state IN ('queued', 'running', 'waiting')`
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
