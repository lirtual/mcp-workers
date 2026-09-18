import { describe, expect, it } from 'vitest';
import { issueExecutorLease, verifyExecutorLease } from '../src/lease.js';

describe('executor Credential Lease', () => {
  it('scopes a short-lived token to one Attempt and physical GitHub run', async () => {
    const token = await issueExecutorLease(
      'lease-secret',
      {
        attemptId: 'att_1',
        runId: 'run_1',
        stepRunId: 'step_1',
        githubRunId: '9001',
        githubRunAttempt: 2,
        permissions: ['manifest:read', 'callback:write']
      },
      { nowSeconds: 1000, ttlSeconds: 120 }
    );

    await expect(
      verifyExecutorLease(token, 'lease-secret', 'manifest:read', 1050)
    ).resolves.toMatchObject({
      attemptId: 'att_1',
      runId: 'run_1',
      stepRunId: 'step_1',
      githubRunId: '9001',
      githubRunAttempt: 2
    });
    await expect(
      verifyExecutorLease(token, 'lease-secret', 'artifact:allocate', 1050)
    ).rejects.toThrow(/permission/i);
  });

  it('rejects expired or incorrectly signed leases', async () => {
    const token = await issueExecutorLease(
      'lease-secret',
      {
        attemptId: 'att_1',
        runId: 'run_1',
        stepRunId: 'step_1',
        githubRunId: '9001',
        githubRunAttempt: 1,
        permissions: ['callback:write']
      },
      { nowSeconds: 1000, ttlSeconds: 60 }
    );

    await expect(
      verifyExecutorLease(token, 'lease-secret', 'callback:write', 1061)
    ).rejects.toThrow(/expired/i);
    await expect(
      verifyExecutorLease(token, 'wrong-secret', 'callback:write', 1050)
    ).rejects.toThrow(/signature/i);
  });
});
