import { describe, expect, it } from 'vitest';
import { parseRemoteExecutorResult } from '../src/remote-result.js';

describe('remote capability output contract', () => {
  it('accepts a small validated archive result', () => {
    const sha256 = 'a'.repeat(64);
    expect(
      parseRemoteExecutorResult('github.archive_markdown', {
        state: 'succeeded',
        output: {
          artifact: {
            artifactId: 'artifact_123',
            name: 'archive.md',
            mediaType: 'text/markdown',
            size: 12,
            sha256,
            sourceUrl: 'https://example.com/'
          }
        }
      })
    ).toEqual({
      state: 'succeeded',
      output: {
        artifact: {
          artifactId: 'artifact_123',
          name: 'archive.md',
          mediaType: 'text/markdown',
          size: 12,
          sha256,
          sourceUrl: 'https://example.com/'
        }
      }
    });
  });

  it('rejects malformed success and unregistered remote capabilities', () => {
    expect(
      parseRemoteExecutorResult('github.archive_markdown', {
        state: 'succeeded',
        output: { artifact: { name: 'wrong.txt' } }
      })
    ).toMatchObject({ state: 'failed', errorCode: 'INVALID_EXECUTOR_RESULT' });

    expect(
      parseRemoteExecutorResult('github.shell', {
        state: 'succeeded',
        output: {}
      })
    ).toMatchObject({ state: 'failed', errorCode: 'INVALID_EXECUTOR_RESULT' });
  });

  it('preserves a bounded registered executor failure', () => {
    expect(
      parseRemoteExecutorResult('github.archive_markdown', {
        state: 'failed',
        errorCode: 'ARCHIVE_FAILED',
        errorSummary: 'cannot write output'
      })
    ).toEqual({
      state: 'failed',
      errorCode: 'ARCHIVE_FAILED',
      errorSummary: 'cannot write output'
    });
  });
});
