import { describe, expect, it } from 'vitest';
import { getWorkflowRegistry } from '../src/registry.js';
import { LEGACY_DEFINITIONS, prepareLegacyImport, type LegacyImportState } from '../src/legacy-import.js';

const entries = getWorkflowRegistry();
const scheduleKey = 'raindrop-daily-snapshot:daily-nine';
function state(): LegacyImportState {
  return {
    definitions: [],
    active: [],
    scheduler: [{
      scheduleKey, lastEvaluatedAt: 1_790_000_000_000,
      lastAdmittedScheduledTime: 1_789_999_940_000,
      nextDueOccurrence: 1_790_000_060_000
    }],
    nonterminal: [],
    approvedConnectionIds: ['raindrop', 'workflow-self']
  };
}

describe('T10 v0.1 import preflight (no D1 writes)', () => {
  it('preserves exactly four frozen ids, original digests, sources and daily-nine cursor', () => {
    const input = state();
    const result = prepareLegacyImport(input);
    expect(result.definitions.map(d => d.workflowId).sort()).toEqual(Object.keys(LEGACY_DEFINITIONS).sort());
    for (const row of result.definitions) {
      expect(row.definitionDigest).toBe(
        LEGACY_DEFINITIONS[row.workflowId as keyof typeof LEGACY_DEFINITIONS]);
      expect(row.alreadyStored).toBe(false);
      expect(JSON.parse(row.normalizedPlanJson)).toEqual(
        entries.find(e => e.metadata.id === row.workflowId)?.plan);
    }
    expect(result.preservedSchedule).toEqual(input.scheduler[0]);
    expect(result.readerGateChanged).toBe(false);
    expect(input.definitions).toEqual([]);
  });

  it('allows identical preexisting pinned definitions without overwriting them', () => {
    const one = prepareLegacyImport(state()).definitions[0]!;
    const input: LegacyImportState = { ...state(), definitions: [{
      definitionDigest: one.definitionDigest, workflowId: one.workflowId,
      normalizedPlanJson: one.normalizedPlanJson, dslVersion: one.dslVersion, sourcePath: one.sourcePath
    }] };
    expect(prepareLegacyImport(input).definitions.find(d => d.definitionDigest === one.definitionDigest))
      .toMatchObject({ alreadyStored: true });
    const corrupt: LegacyImportState = { ...input, definitions: [{
      ...input.definitions[0]!, normalizedPlanJson: '{}'
    }] };
    expect(() => prepareLegacyImport(corrupt)).toThrow(/cannot be overwritten/);
  });

  it('rejects incomplete, duplicated or drifted static definition inventory', () => {
    const baseline = state();
    expect(() => prepareLegacyImport(baseline, entries.slice(1))).toThrow(/inventory/);
    expect(() => prepareLegacyImport(baseline, [...entries.slice(1), entries[1]!]))
      .toThrow(/inventory/);
    const changed = entries.map(entry => entry.metadata.id === 'local-http-smoke'
      ? { ...entry, definitionDigest: 'f'.repeat(64) } : entry);
    expect(() => prepareLegacyImport(baseline, changed)).toThrow(/identity/);
    const changedPlan = entries.map(entry => entry.metadata.id === 'local-http-smoke'
      ? { ...entry, plan: { ...(entry.plan as object), name: 'drifted' } } : entry);
    expect(() => prepareLegacyImport(baseline, changedPlan)).toThrow(/digest mismatch/);
  });

  it('does not replace a conflicting active pointer or silently approve MCP connections', () => {
    expect(() => prepareLegacyImport({
      ...state(), active: [{ workflowId: 'raindrop-daily-snapshot', activeDigest: 'f'.repeat(64) }]
    })).toThrow(/separate approved CAS/);
    expect(() => prepareLegacyImport({ ...state(), approvedConnectionIds: [] }))
      .toThrow(/explicit compatible approval/);
  });

  it('fails closed for missing or inconsistent historical daily-nine high-water mark', () => {
    expect(() => prepareLegacyImport({ ...state(), scheduler: [] })).toThrow(/high-water mark/);
    expect(() => prepareLegacyImport({ ...state(), scheduler: [
      { scheduleKey, lastEvaluatedAt: 60_000, lastAdmittedScheduledTime: 120_000 }
    ] })).toThrow(/high-water mark/);
  });

  it('blocks missing nonterminal plans, unsupported manifests and unknown historical digests', () => {
    const run = {
      runId: 'run_legacy', definitionDigest: LEGACY_DEFINITIONS['local-http-smoke'],
      dslVersion: 1, manifestVersions: [1], hasInvalidManifest: false,
      normalizedPlanJson: JSON.stringify(entries.find(e => e.metadata.id === 'local-http-smoke')!.plan)
    };
    expect(prepareLegacyImport({ ...state(), nonterminal: [run] }).nonterminalRuns).toBe(1);
    expect(() => prepareLegacyImport({ ...state(), nonterminal: [{
      ...run, manifestVersions: [2]
    }] })).toThrow(/compatibility gate/);
    expect(() => prepareLegacyImport({ ...state(), nonterminal: [{
      ...run, definitionDigest: 'a'.repeat(64)
    }] })).toThrow(/historical pinned definition/);
  });
});
