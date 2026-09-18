import { describe, expect, it } from 'vitest';
import { presignR2Url } from '../src/r2-signing.js';
import type { Env } from '../src/types.js';

const env = {
  R2_ACCOUNT_ID: 'acct',
  R2_BUCKET_NAME: 'bucket',
  R2_ACCESS_KEY_ID: 'AKID',
  R2_SECRET_ACCESS_KEY: 'SECRET'
} as unknown as Env;

describe('R2 SigV4 presigning', () => {
  it('matches an independent S3 SigV4 query-signing vector for PUT', async () => {
    const url = await presignR2Url(env, {
      method: 'PUT',
      key: 'runs/run/artifact.md',
      expiresInSeconds: 300,
      now: new Date('2026-09-18T01:02:03.000Z'),
      headers: {
        'Content-Type': 'text/markdown',
        'x-amz-meta-artifact-id': 'artifact_1',
        'x-amz-meta-sha256': 'a'.repeat(64)
      }
    });

    expect(url).toBe(
      'https://acct.r2.cloudflarestorage.com/bucket/runs/run/artifact.md?' +
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&' +
        'X-Amz-Credential=AKID%2F20260918%2Fauto%2Fs3%2Faws4_request&' +
        'X-Amz-Date=20260918T010203Z&' +
        'X-Amz-Expires=300&' +
        'X-Amz-SignedHeaders=content-type%3Bhost%3Bx-amz-meta-artifact-id%3Bx-amz-meta-sha256&' +
        'X-Amz-Signature=b86956f062fab7e6f28eeb14d8061b025101301699f5541f74d189afb83db68b'
    );
  });

  it('generates a GET URL without persisting or requiring upload headers', async () => {
    const url = await presignR2Url(env, {
      method: 'GET',
      key: 'runs/run/a b.txt',
      expiresInSeconds: 60,
      now: new Date('2026-09-18T01:02:03.000Z')
    });

    expect(url).toContain('/bucket/runs/run/a%20b.txt?');
    expect(url).toContain('X-Amz-Expires=60');
    expect(url).toContain('X-Amz-SignedHeaders=host');
    expect(url).not.toContain('SECRET');
  });

  it('rejects unsafe expiration values', async () => {
    await expect(
      presignR2Url(env, {
        method: 'GET',
        key: 'x',
        expiresInSeconds: 0
      })
    ).rejects.toThrow(/between 1 and 604800/);
  });
});
