import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileWorkflowText } from '../src/compiler.js';
import { workflowRegistry } from '../src/generated/workflow-registry.js';

const raindropPath = 'workflows/raindrop-daily-snapshot.yaml';
const raindropYaml = readFileSync(raindropPath, 'utf8');
const legacy = workflowRegistry.find(entry => entry.metadata.id === 'raindrop-daily-snapshot');

describe('T11 initial catalog Raindrop canonical compatibility', () => {
  it('preserves the pinned legacy canonical digest when compiled against approved policy', () => {
    expect(legacy).toBeDefined();
    const approved = compileWorkflowText(raindropYaml, raindropPath, {
      revision: 1,
      connections: {
        raindrop: {
          version: 1,
          enabled: true,
          tools: { list_raindrops: { effect: 'read' } }
        }
      }
    });
    expect(approved.definitionDigest).toBe(legacy!.definitionDigest);
    expect(approved.metadata).toEqual(legacy!.metadata);
    expect(approved.plan).toEqual(legacy!.plan);
  });

  it('cannot publish Raindrop through an unapproved or disabled connection', () => {
    expect(() => compileWorkflowText(raindropYaml, raindropPath, {
      revision: 1, connections: {}
    })).toThrow(/Unapproved or disabled/);
    expect(() => compileWorkflowText(raindropYaml, raindropPath, {
      revision: 1,
      connections: {
        raindrop: {
          version: 1,
          enabled: false,
          tools: { list_raindrops: { effect: 'read' } }
        }
      }
    })).toThrow(/Unapproved or disabled/);
  });
});
