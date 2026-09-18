import { describe, expect, it, vi } from 'vitest';
import {
  allocateArtifactUploadForManifest,
  artifactObjectKey,
  artifactReadReferences,
  finalizeCallbackArtifactsForManifest,
  type ArtifactStore
} from '../src/artifacts.js';
import type { ExecutionManifest } from '../src/executor-protocol.js';
import type { ArtifactAllocationInput, ArtifactRecord } from '../src/storage.js';
import type { Env } from '../src/types.js';

const digest = 'a'.repeat(64);

function manifest(): ExecutionManifest {
  return {
    version: 1,
    runId: 'run_1',
    stepRunId: 'step_1',
    attemptId: 'att_1',
    operationId: 'op_1',
    capability: 'github.archive_markdown',
    input: {
      content: '# hello',
      source_url: 'https://example.com/'
    }
  };
}

function env(head: (key: string) => Promise<unknown>): Env {
  return {
    R2_ACCOUNT_ID: 'acct',
    R2_BUCKET_NAME: 'bucket',
    R2_ACCESS_KEY_ID: 'AKID',
    R2_SECRET_ACCESS_KEY: 'SECRET',
    ARTIFACTS: {
      head
    }
  } as unknown as Env;
}

class MemoryArtifactStore implements ArtifactStore {
  private readonly rows = new Map<string, ArtifactRecord>();
  private readonly byAttemptName = new Map<string, string>();

  async getArtifactByAttemptName(attemptId: string, name: string): Promise<ArtifactRecord | null> {
    const id = this.byAttemptName.get(`${attemptId}:${name}`);
    return id ? this.rows.get(id) ?? null : null;
  }

  async getOrCreateArtifactAllocation(input: ArtifactAllocationInput): Promise<ArtifactRecord> {
    const key = `${input.attemptId}:${input.name}`;
    const existingId = this.byAttemptName.get(key);
    if (existingId) return this.rows.get(existingId)!;

    const row: ArtifactRecord = {
      artifactId: input.artifactId,
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      objectKey: input.objectKey,
      name: input.name,
      mediaType: input.mediaType,
      expectedSize: input.expectedSize,
      expectedSha256: input.expectedSha256,
      state: 'allocated',
      createdAt: '2026-09-18T00:00:00.000Z'
    };
    this.rows.set(row.artifactId, row);
    this.byAttemptName.set(key, row.artifactId);
    return row;
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    return this.rows.get(artifactId) ?? null;
  }

  async finalizeArtifact(
    artifactId: string,
    size: number,
    sha256: string
  ): Promise<ArtifactRecord> {
    const row = this.rows.get(artifactId);
    if (!row) throw new Error('missing');
    const finalized: ArtifactRecord = {
      ...row,
      state: 'ready',
      size,
      sha256,
      finalizedAt: '2026-09-18T00:01:00.000Z'
    };
    this.rows.set(artifactId, finalized);
    return finalized;
  }

  async listArtifacts(runId: string): Promise<ArtifactRecord[]> {
    return [...this.rows.values()].filter(row => row.runId === runId && row.state === 'ready');
  }
}

describe('canonical Artifact protocol', () => {
  it('allocates a Worker-chosen Attempt-scoped key and reuses it on retry', async () => {
    const store = new MemoryArtifactStore();
    const runtime = env(async () => null);
    const request = {
      name: 'archive.md',
      mediaType: 'text/markdown',
      size: 7,
      sha256: digest
    };

    const first = await allocateArtifactUploadForManifest(runtime, manifest(), request, {
      store,
      now: new Date('2026-09-18T01:02:03.000Z')
    });
    const second = await allocateArtifactUploadForManifest(runtime, manifest(), request, {
      store,
      now: new Date('2026-09-18T01:03:03.000Z')
    });

    expect(second.artifactId).toBe(first.artifactId);
    expect(first.requiredHeaders).toEqual({
      'Content-Type': 'text/markdown',
      'x-amz-meta-artifact-id': first.artifactId,
      'x-amz-meta-sha256': digest
    });
    expect(first.uploadUrl).toContain(
      `/bucket/runs/run_1/steps/step_1/attempts/att_1/artifacts/${first.artifactId}/archive.md?`
    );
    expect(first.uploadUrl).not.toContain('SECRET');
    expect(first.expiresInSeconds).toBe(300);
  });

  it('rejects allocation retry metadata drift', async () => {
    const store = new MemoryArtifactStore();
    const runtime = env(async () => null);
    await allocateArtifactUploadForManifest(
      runtime,
      manifest(),
      {
        name: 'archive.md',
        mediaType: 'text/markdown',
        size: 7,
        sha256: digest
      },
      { store }
    );

    await expect(
      allocateArtifactUploadForManifest(
        runtime,
        manifest(),
        {
          name: 'archive.md',
          mediaType: 'text/markdown',
          size: 8,
          sha256: digest
        },
        { store }
      )
    ).rejects.toThrow(/does not match/);
  });

  it('refuses callback registration until the allocated R2 object exists', async () => {
    const store = new MemoryArtifactStore();
    const runtime = env(async () => null);
    const allocation = await allocateArtifactUploadForManifest(
      runtime,
      manifest(),
      {
        name: 'archive.md',
        mediaType: 'text/markdown',
        size: 7,
        sha256: digest
      },
      { store }
    );

    await expect(
      finalizeCallbackArtifactsForManifest(
        runtime,
        manifest(),
        {
          state: 'succeeded',
          output: {
            artifact: {
              artifactId: allocation.artifactId,
              name: 'archive.md',
              mediaType: 'text/markdown',
              size: 7,
              sha256: digest,
              sourceUrl: 'https://example.com/'
            }
          }
        },
        { store }
      )
    ).rejects.toThrow(/does not exist/);
  });

  it('verifies R2 size/content-type/signed metadata before finalizing a reference', async () => {
    const store = new MemoryArtifactStore();
    let keySeen = '';
    const runtime = env(async key => {
      keySeen = key;
      return {
        size: 7,
        httpMetadata: { contentType: 'text/markdown' },
        customMetadata: {
          sha256: digest,
          'artifact-id': allocation.artifactId
        }
      };
    });
    const allocation = await allocateArtifactUploadForManifest(
      runtime,
      manifest(),
      {
        name: 'archive.md',
        mediaType: 'text/markdown',
        size: 7,
        sha256: digest
      },
      { store }
    );

    const result = await finalizeCallbackArtifactsForManifest(
      runtime,
      manifest(),
      {
        state: 'succeeded',
        output: {
          artifact: {
            artifactId: allocation.artifactId,
            name: 'archive.md',
            mediaType: 'text/markdown',
            size: 7,
            sha256: digest,
            sourceUrl: 'https://example.com/'
          }
        }
      },
      { store }
    );

    expect(keySeen).toContain(`/artifacts/${allocation.artifactId}/archive.md`);
    expect(result).toEqual({
      state: 'succeeded',
      output: {
        artifact: {
          artifactId: allocation.artifactId,
          name: 'archive.md',
          mediaType: 'text/markdown',
          size: 7,
          sha256: digest,
          sourceUrl: 'https://example.com/'
        }
      }
    });
  });

  it('generates short-lived GET URLs on demand without persisting them', async () => {
    const store = new MemoryArtifactStore();
    const runtime = env(async () => null);
    const allocation = await allocateArtifactUploadForManifest(
      runtime,
      manifest(),
      {
        name: 'archive.md',
        mediaType: 'text/markdown',
        size: 7,
        sha256: digest
      },
      { store }
    );
    await store.finalizeArtifact(allocation.artifactId, 7, digest);

    const refs = await artifactReadReferences(runtime, 'run_1', {
      store,
      now: new Date('2026-09-18T01:02:03.000Z')
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      artifactId: allocation.artifactId,
      name: 'archive.md',
      readUrlExpiresInSeconds: 300
    });
    expect(refs[0]!.readUrl).toContain('X-Amz-Expires=300');
    expect(JSON.stringify(await store.getArtifact(allocation.artifactId))).not.toContain('X-Amz-');
  });

  it('keeps generated object keys deterministic in scope shape but server-owned', () => {
    expect(
      artifactObjectKey('run_1', 'step_1', 'att_1', 'artifact_1', 'archive.md')
    ).toBe(
      'runs/run_1/steps/step_1/attempts/att_1/artifacts/artifact_1/archive.md'
    );
    expect(() =>
      artifactObjectKey('run/escape', 'step_1', 'att_1', 'artifact_1', 'archive.md')
    ).toThrow(/unsupported key characters/);
  });
});
