import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStatus, StateError, limitResult, cleanError } from '../src/store.ts';
import { success } from '../src/tools.ts';

test('MCP tool response limit counts UTF-8 bytes not JavaScript code units', () => {
  const response=success({definition:'汉'.repeat(25000)});
  assert.equal(response.isError,true);
});

test('client-facing Run state distinguishes platform complete from business failure/uncertainty', () => {
  assert.equal(applyStatus('complete', 'indeterminate'), 'indeterminate');
  assert.equal(applyStatus('complete', 'failed'), 'failed');
  assert.equal(applyStatus('complete', 'queued'), 'queued');
  assert.equal(applyStatus('complete', 'running'), 'running');
  assert.equal(applyStatus('complete', 'succeeded'), 'succeeded');
  assert.equal(applyStatus('running', 'running'), 'running');
  assert.equal(applyStatus('errored', 'running'), 'running');
  assert.equal(applyStatus('terminated', 'queued'), 'queued');
});
test('result and error responses stay bounded and secret-free', () => {
  assert.equal(limitResult({value:'safe'}).value, 'safe');
  assert.throws(()=>limitResult({value:'x'.repeat(70_000)}), StateError);
  assert.equal(cleanError(new Error('Authorization: Bearer abc')), 'internal_error');
});
