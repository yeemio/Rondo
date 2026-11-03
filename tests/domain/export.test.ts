import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadyHarness, startAttempt } from '../fixtures/harness';
import { buildExportPayload, finishExport, EXPORT_CATEGORIES } from '../../modules/learning/maintenance';
import { exportFiles } from '../../apps/web/src/client/browser-export';

test('export requires confirmation, projects private code fields away, scopes families, and never mutates learning facts', async () => {
  const h = await createReadyHarness();
  try {
    const { attemptId, cycleId } = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const scope = { familyId: h.harness.familyId, actorId: h.guardianCtx.actorId };
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId, cycleId };
    const command = async (kind: Parameters<typeof h.harness.cmd>[1]['kind'], payload: unknown, version: number) => {
      const receipt = await h.harness.cmd(h.learnerCtx, { kind, idempotencyKey: `export-${kind}`, payload, target, expectedAttemptVersion: version });
      assert.equal(receipt.status, 'APPLIED'); return receipt.attemptVersion!;
    };
    let v = await command('learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }, 1);
    v = await command('learning.commitOperation', { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } }, v);
    v = await command('learning.submitResponse', { response: [{ kind: 'propertyJudgments', claims: [
      { propertyId: 'radius', direction: 'INCREASE' }, { propertyId: 'diameter', direction: 'INCREASE' }, { propertyId: 'height', direction: 'UNCHANGED' },
    ] }] }, v);
    v = await command('learning.beginExplanation', {}, v);
    await command('learning.saveExplanation', { selections: [], freeText: '<script>中文合成学习文本</script>', transcribedByGuardian: false }, v);
    await h.harness.cmd(h.guardianCtx, { kind: 'guardian.recordAssistance', idempotencyKey: 'export-help', target: { scope: 'FAMILY' }, payload: { attemptId, category: 'RESTATE', note: '合成观察' } });
    await h.harness.storage.tx('synthetic.private.canary', async (repos) => {
      await repos.learningEvent.append(scope, { attemptId, familyId: scope.familyId, commandKind: 'code.requestRun', eventType: 'CODE_RUN_STATUS', payloadVersion: '1', occurredAt: h.harness.clock.now(),
        payloadJson: JSON.stringify({ privatePassed: 'PRIVATE_TEST_CANARY', run: { source: '合成代码', stdout: '公开输出', workerJobId: 'WORKER_SECRET', imageId: 'IMAGE_SECRET' }, token: 'TOKEN_SECRET' }) });
    });
    const prepare = await h.harness.cmd(h.guardianCtx, { kind: 'guardian.prepareExport', idempotencyKey: 'export-prepare', target: { scope: 'FAMILY' }, payload: { scope: { categories: [...EXPORT_CATEGORIES] } } });
    const ref = prepare.effectRefs[0].slice(7);
    await assert.rejects(buildExportPayload(h.harness.storage, scope, ref, () => 1, h.harness.content), (e: unknown) => (e as { code: string }).code === 'INVALID_OPERATION');
    await assert.rejects(finishExport(h.harness.storage, scope, { opId: ref, outcome: 'COMPLETED' }), (e: unknown) => (e as { code: string }).code === 'INVALID_OPERATION');
    const learnerDenied = await h.harness.cmd(h.learnerCtx, { kind: 'guardian.prepareExport', idempotencyKey: 'export-learner-denied', target: { scope: 'FAMILY' }, payload: { scope: { categories: ['ALIASES'] } } });
    assert.equal(learnerDenied.errorCode, 'FORBIDDEN');
    await h.harness.cmd(h.guardianCtx, { kind: 'guardian.confirmExport', idempotencyKey: 'export-confirm', target: { scope: 'FAMILY' }, payload: { preparedVersion: ref } });
    const db = h.harness.storage.rawDatabase();
    const snapshot = () => JSON.stringify(['learningAttempt', 'learningCycle', 'learningEvent', 'submission', 'evaluation', 'explanationRevision', 'assistanceRecord'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    const before = snapshot();
    const payload = await buildExportPayload(h.harness.storage, scope, ref, () => h.harness.clock.now(), h.harness.content);
    for (const key of EXPORT_CATEGORIES) assert.ok((payload.categories[key] as unknown[]).length > 0, key);
    const json = JSON.stringify(payload);
    for (const forbidden of ['PRIVATE_TEST_CANARY', 'WORKER_SECRET', 'IMAGE_SECRET', 'TOKEN_SECRET', 'derivedKey', 'password', 'sessionId', 'privatePassed']) assert.ok(!json.includes(forbidden), forbidden);
    assert.equal(snapshot(), before);
    assert.equal((await h.harness.server.query(h.guardianCtx, { kind: 'guardian.exportStatus', exportId: ref }) as { phase: string }).phase, 'CONFIRMED');
    await assert.rejects(buildExportPayload(h.harness.storage, { familyId: 'foreign-family', actorId: 'foreign' }, ref, () => 1, h.harness.content), (e: unknown) => (e as { code: string }).code === 'INVALID_OPERATION');
    await assert.rejects(buildExportPayload(h.harness.storage, scope, '../bad', () => 1, h.harness.content), (e: unknown) => (e as { code: string }).code === 'INVALID_OPERATION');
    const files = exportFiles(payload, ref);
    assert.deepEqual(files.map((f) => f.type), ['application/json;charset=utf-8', 'text/plain;charset=utf-8']);
    assert.ok(files[1].text.includes('中文合成学习文本'));
    assert.ok(files[1].text.includes('解释：1 条'));
    const minimal = await h.harness.cmd(h.guardianCtx, { kind: 'guardian.prepareExport', idempotencyKey: 'export-minimal', target: { scope: 'FAMILY' }, payload: { scope: { categories: ['ALIASES'] } } });
    const minimalRef = minimal.effectRefs[0].slice(7);
    await h.harness.cmd(h.guardianCtx, { kind: 'guardian.confirmExport', idempotencyKey: 'export-minimal-confirm', target: { scope: 'FAMILY' }, payload: { preparedVersion: minimalRef } });
    assert.deepEqual(Object.keys((await buildExportPayload(h.harness.storage, scope, minimalRef, () => 1, h.harness.content)).categories), ['ALIASES']);
  } finally { await h.harness.closeAll(); }
});

test('export includes instance-bound public prompt and initial parameters without observation material before it is unlocked', async () => {
  const h = await createReadyHarness();
  try {
    const { questionInstanceId } = await startAttempt(h.harness, h.learnerCtx, h.learnerId, 'question-export-start');
    const target = { scope: 'FAMILY' as const };
    const prep = await h.harness.cmd(h.guardianCtx, { kind: 'guardian.prepareExport', idempotencyKey: 'question-export-prep', target, payload: { scope: { categories: ['CONTENT_VERSIONS'] } } });
    const ref = prep.effectRefs[0].slice(7);
    await h.harness.cmd(h.guardianCtx, { kind: 'guardian.confirmExport', idempotencyKey: 'question-export-confirm', target, payload: { preparedVersion: ref } });
    const payload = await buildExportPayload(h.harness.storage, { familyId: h.harness.familyId, actorId: h.guardianCtx.actorId }, ref, () => h.harness.clock.now(), h.harness.content);
    const content = payload.categories.CONTENT_VERSIONS as Array<{ tasks: Array<{ publicQuestion: { questionInstanceId: string; taskVersion: string; materialVisibility: string; prompt: unknown; scene: { state: unknown } } }> }>;
    const question = content[0].tasks[0].publicQuestion;
    assert.equal(question.questionInstanceId, questionInstanceId); assert.equal(question.taskVersion, '1'); assert.equal(question.materialVisibility, 'PREDICTION');
    assert.ok(JSON.stringify(question.prompt).includes('当前圆筒 r=30mm，h=80mm'));
    assert.ok(!JSON.stringify(question.prompt).includes('观察：直径'));
    assert.ok(JSON.stringify(question.scene.state).includes('"radiusMm":30'));
    assert.ok(JSON.stringify(question.scene.state).includes('"heightMm":80'));
    assert.ok(exportFiles(payload, ref)[1].text.includes('当前圆筒 r=30mm，h=80mm'));
  } finally { await h.harness.closeAll(); }
});
