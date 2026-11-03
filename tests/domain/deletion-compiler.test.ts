import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompilerService } from '../../workers/cpp/compiler.mjs';

test('deletion: compiler cleanup requires exact instance/run and stable terminal absence of execution/removal', () => {
  const service = new CompilerService({ compilerContractId: 'synthetic', imageId: 'no-container', platform: 'synthetic' });
  const state = service as unknown as { jobs: Map<string, any>; requests: Map<string, string>; active: string | null; queue: string[]; removals: Map<string, Promise<unknown>> };
  const add = (id: string, requestId: string, status = 'OK', extras = {}) => {
    state.jobs.set(id, { id, requestId, source: 'synthetic source', stdin: 'synthetic stdin', state: status, container: null, containers: [], ...extras });
    state.requests.set(requestId, id);
  };
  add('visible', 'run-1-visible'); add('private', 'run-1-private-0'); add('similar', 'run-10-visible');
  add('nested', 'run-1-private-0-visible'); add('suffix', 'run-1-visible-extra');
  add('unknown', 'run-1-private-1', 'UNKNOWN'); add('active', 'run-1-private-2'); state.active = 'active';
  add('queued', 'run-1-private-3'); state.queue.push('queued');
  add('container', 'run-1-private-4', 'OK', { container: 'unconfirmed-container' });
  add('removing', 'run-1-private-5', 'OK', { containers: ['pending-removal'] }); state.removals.set('pending-removal', Promise.resolve());
  add('running', 'run-1-private-6', 'RUNNING');
  assert.deepEqual(service.forgetDeletionRun!('run-1', 'another-instance'), { owned: false, deleted: 0, pending: 0 });
  assert.equal(state.jobs.size, 11);
  const result = service.forgetDeletionRun!('run-1', service.capability().instanceId);
  assert.deepEqual(result, { owned: true, deleted: 2, pending: 6 });
  assert.ok(!state.jobs.has('visible')); assert.ok(!state.requests.has('run-1-visible'));
  for (const id of ['similar', 'nested', 'suffix', 'unknown', 'active', 'queued', 'container', 'removing', 'running']) assert.ok(state.jobs.has(id), id);
  assert.deepEqual(service.forgetDeletionRun!('run-1', service.capability().instanceId), { owned: true, deleted: 0, pending: 6 });
});
