import { describe, expect, it } from 'vitest';
import { makeAttemptId, makeStepIdentity } from '../src/identities.js';

describe('logical execution identities', () => {
  it('keeps Step Run and Operation IDs stable for the same logical step', async () => {
    const first = await makeStepIdentity('run_abc', 'publish');
    const second = await makeStepIdentity('run_abc', 'publish');

    expect(second).toEqual(first);
    expect(first.operationId).toMatch(/^op_[a-f0-9]{32}$/);
    expect(first.stepRunId).toMatch(/^step_[a-f0-9]{32}$/);
  });

  it('changes Attempt ID across retries without changing Operation ID', async () => {
    const identity = await makeStepIdentity('run_abc', 'publish');
    const attempt1 = await makeAttemptId(identity.stepRunId, 1);
    const attempt2 = await makeAttemptId(identity.stepRunId, 2);

    expect(attempt1).not.toBe(attempt2);
    expect(attempt1).toMatch(/^att_[a-f0-9]{32}$/);
    expect(attempt2).toMatch(/^att_[a-f0-9]{32}$/);
    expect((await makeStepIdentity('run_abc', 'publish')).operationId).toBe(identity.operationId);
  });
});
