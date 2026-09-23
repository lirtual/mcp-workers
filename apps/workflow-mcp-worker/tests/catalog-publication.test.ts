import { describe, expect, it } from 'vitest';
import { prepareCatalogActivation, prepareCatalogPublication } from '../src/catalog-publication.js';

const yaml = `version: 1
id: isolated-catalog-smoke
name: Isolated catalog smoke
triggers:
  - type: manual
steps:
  fetch:
    uses: http.read
    with:
      url: https://example.com/
`;
const source = {
  repository: 'lirtual/approved-catalog',
  repositoryId: '123456789',
  expectedRepository: 'lirtual/approved-catalog',
  expectedRepositoryId: '123456789',
  requestedSha: 'a'.repeat(40),
  checkedOutSha: 'a'.repeat(40),
  publisherRunId: '12345',
  publisherRunAttempt: 1,
  sourcePath: 'workflows/isolated-catalog-smoke.yaml',
  yaml,
  policy: { revision: 3, connections: {} }
};

describe('T09 trusted, definition-only catalog publication', () => {
  it('emits only the immutable stage envelope and a deterministic CAS activation', () => {
    const staged = prepareCatalogPublication(source);
    expect(Object.keys(staged).sort()).toEqual([
      'definitionDigest', 'manifestVersion', 'metadata', 'plan', 'policyRevision',
      'publicationId', 'sourcePath', 'sourceSha', 'workflowId'
    ]);
    expect(staged).toMatchObject({
      manifestVersion: 1, workflowId: 'isolated-catalog-smoke',
      sourceSha: 'a'.repeat(40), policyRevision: 3,
      metadata: { definitionDigest: staged.definitionDigest }
    });
    expect(staged.definitionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(prepareCatalogPublication(source)).toEqual(staged);
    expect(prepareCatalogPublication({ ...source, publisherRunId: '12346' }).publicationId)
      .not.toBe(staged.publicationId);
    const action = prepareCatalogActivation(staged, { activeDigest: null, revision: 0 });
    expect(action).toEqual({
      actionId: action.actionId, workflowId: staged.workflowId,
      expectedDigest: null, targetDigest: staged.definitionDigest, expectedRevision: 0
    });
    expect(action.actionId).toMatch(/^act_[0-9a-f]{40}$/);
    expect(prepareCatalogActivation(staged, { activeDigest: null, revision: 0 })).toEqual(action);
    expect(prepareCatalogActivation(staged, {
      activeDigest: staged.definitionDigest, revision: 1
    }).actionId).not.toBe(action.actionId);
  });

  it('refuses an unapproved or replaced repository and any unpinned checkout', () => {
    expect(() => prepareCatalogPublication({ ...source, repository: 'attacker/catalog' }))
      .toThrow(/identity/);
    expect(() => prepareCatalogPublication({ ...source, repositoryId: '999' }))
      .toThrow(/identity/);
    expect(() => prepareCatalogPublication({ ...source, checkedOutSha: 'b'.repeat(40) }))
      .toThrow(/checkout/);
    expect(() => prepareCatalogPublication({ ...source, requestedSha: 'refs/heads/main' }))
      .toThrow(/checkout/);
    expect(() => prepareCatalogPublication({ ...source, publisherRunId: 'not-a-run' }))
      .toThrow(/run identity/);
    expect(() => prepareCatalogPublication({ ...source, sourcePath: '../secrets.yaml' }))
      .toThrow(/workflows/);
    expect(() => prepareCatalogPublication({ ...source, sourcePath: 'workflows/../other.yaml' }))
      .toThrow(/workflows/);
  });

  it('only compiles catalog YAML against the trusted policy and recomputes the digest', () => {
    const first = prepareCatalogPublication(source);
    const changed = prepareCatalogPublication({ ...source, yaml: yaml.replace(
      'Isolated catalog smoke', 'Isolated catalog smoke v2'
    ) });
    expect(changed.definitionDigest).not.toBe(first.definitionDigest);
    expect(changed.publicationId).not.toBe(first.publicationId);
    expect(() => prepareCatalogPublication({ ...source, policy: { revision: 0, connections: {} } }))
      .toThrow(/policy revision/);
    expect(() => prepareCatalogPublication({ ...source, yaml: yaml.replace(
      'http.read', 'mcp.call'
    ) })).toThrow();
    expect(() => prepareCatalogPublication({ ...source, yaml: yaml.replace(
      'https://example.com/', 'https://example.com/\n    auth: ${{ env.SECRET }}'
    ) })).toThrow();
    expect(() => prepareCatalogActivation(first, { activeDigest: 'not-a-digest', revision: 1 }))
      .toThrow(/revision or digest/);
  });
});
