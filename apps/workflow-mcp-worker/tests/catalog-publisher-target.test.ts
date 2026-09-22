import { describe, expect, it } from 'vitest';
import { validateCatalogPublisherTarget, type CatalogPublisherMode } from '../src/catalog-publisher-target.js';

const live = 'https://workflow-mcp-worker.aiyaya.workers.dev';
const approved = { allowLiveTarget: 'true', allowLiveMutations: 'true' };

describe('T09 source-approved publisher endpoint and authorization', () => {
  it.each(['dry-run', 'stage', 'activate'] as CatalogPublisherMode[])(
    'accepts the exact Worker origin in approved mode %s', mode => {
      expect(validateCatalogPublisherTarget(live, mode, approved).href).toBe(live + '/');
      expect(validateCatalogPublisherTarget(live + '/', mode, approved).href).toBe(live + '/');
    }
  );

  it.each([
    'https://example.com',
    'https://workflow-mcp-worker.aiyaya.workers.dev.evil.example',
    'https://user:pass@workflow-mcp-worker.aiyaya.workers.dev',
    'https://workflow-mcp-worker.aiyaya.workers.dev:8443',
    'http://workflow-mcp-worker.aiyaya.workers.dev',
    'https://workflow-mcp-worker.aiyaya.workers.dev/mcp',
    'https://workflow-mcp-worker.aiyaya.workers.dev/?next=evil',
    'https://workflow-mcp-worker.aiyaya.workers.dev/#fragment',
    ' https://workflow-mcp-worker.aiyaya.workers.dev'
  ])('rejects an untrusted or rewritten endpoint %s before token request', url => {
    expect(() => validateCatalogPublisherTarget(url, 'dry-run', approved))
      .toThrow(/source-approved Worker/);
  });

  it('rejects even dry-run without exact owner target approval', () => {
    expect(() => validateCatalogPublisherTarget(live, 'dry-run', {}))
      .toThrow(/target approval/);
    expect(() => validateCatalogPublisherTarget(live, 'dry-run', { allowLiveTarget: 'TRUE' }))
      .toThrow(/target approval/);
  });

  it.each(['stage', 'activate'] as CatalogPublisherMode[])(
    'rejects %s when only read-only approval is granted', mode => {
      expect(() => validateCatalogPublisherTarget(live, mode, { allowLiveTarget: 'true' }))
        .toThrow(/mutation approval/);
      expect(() => validateCatalogPublisherTarget(live, mode, {
        allowLiveTarget: 'true', allowLiveMutations: 'false'
      })).toThrow(/mutation approval/);
    }
  );

  it('permits read-only dry-run without mutation approval', () => {
    expect(validateCatalogPublisherTarget(live, 'dry-run', { allowLiveTarget: 'true' }).href)
      .toBe(live + '/');
  });
});
