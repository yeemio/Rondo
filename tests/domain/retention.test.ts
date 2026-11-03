import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createReadyHarness, Harness, GUARDIAN_PASSPHRASE, SYNTH_RELEASE_ID } from '../fixtures/harness';
import type { LearningAttemptRecord } from '../../modules/contracts/server/storage';
import { applyRollingRetention } from '../../modules/learning/maintenance';
import { parsePublicProjection } from '../../modules/contracts/public/queries';

const DAY = 86_400_000;
function options() {
  const parent = resolve('../synthetic-data'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'domain-retention-'));
  return { dbFile: join(root, 'learning.sqlite'), contentRoot: join(root, 'content') };
}
const invalid = (e: unknown) => (e as { code?: string }).code === 'INVALID_OPERATION';
const forbidden = (e: unknown) => (e as { code?: string }).code === 'FORBIDDEN';

test('retention: unset policy stays unset; preview/cancel, invalid inputs and denied roles cannot write policy', async () => {
  const h = await createReadyHarness(options());
  try {
    const state = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.retentionPolicy' });
    assert.ok(state.kind === 'guardian.retentionPolicy'); assert.equal(state.policy, null); assert.equal(state.lastCleanup, null);
    parsePublicProjection(state);
    const before = JSON.stringify(h.harness.storage.rawDatabase().prepare('SELECT * FROM retentionPolicy').all());
    const preview = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.retentionPreview', mode: 'ROLLING_DAYS', rollingDays: 30 });
    assert.ok(preview.kind === 'guardian.retentionPreview'); assert.equal(preview.affectedCount, 0); parsePublicProjection(preview);
    // Cancelling after a read has no command and creates no policy/operation/receipt.
    assert.equal(JSON.stringify(h.harness.storage.rawDatabase().prepare('SELECT * FROM retentionPolicy').all()), before);
    assert.equal((h.harness.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM dataOperation').get() as {n:number}).n, 0);
    for (const rollingDays of [0, -1, 1.5, 3651]) {
      await assert.rejects(h.harness.server.query(h.guardianCtx, { kind: 'guardian.retentionPreview', mode: 'ROLLING_DAYS', rollingDays }), invalid);
      await assert.rejects(h.harness.cmd(h.guardianCtx, { kind: 'family.setRetention', idempotencyKey: `invalid-${rollingDays}`, target: { scope: 'FAMILY' }, payload: { mode: 'ROLLING_DAYS', rollingDays, confirmedPreviewVersion: preview.previewVersion } }), invalid);
    }
    await assert.rejects(h.harness.server.query(h.guardianCtx, { kind: 'guardian.retentionPreview', mode: 'UNTIL_GUARDIAN_DELETES', rollingDays: 30 }), invalid);
    await assert.rejects(h.harness.server.query(h.learnerCtx, { kind: 'guardian.retentionPolicy' }), forbidden);
    await assert.rejects(h.harness.server.query(h.learnerCtx, { kind: 'guardian.retentionPreview', mode: 'ROLLING_DAYS', rollingDays: 30 }), forbidden);
    await assert.rejects(h.harness.server.query(h.guardianCtx, { kind: 'guardian.retentionPolicy', familyId: 'foreign-family' } as never), invalid);
    const denied = await h.harness.cmd(h.learnerCtx, { kind: 'family.setRetention', idempotencyKey: 'retention-denied', target: { scope: 'FAMILY' }, payload: { mode: 'ROLLING_DAYS', rollingDays: 30, confirmedPreviewVersion: preview.previewVersion } });
    assert.equal(denied.status, 'REJECTED'); assert.equal(denied.errorCode, 'FORBIDDEN');
    assert.equal(JSON.stringify(h.harness.storage.rawDatabase().prepare('SELECT * FROM retentionPolicy').all()), before);
  } finally { await h.harness.closeAll(); }
});

test('retention: displayed scope and preceding policy bind confirmation; stale, edited and foreign versions never write', async () => {
  const h = await createReadyHarness(options());
  try {
    const preview = async (days: number) => {
      const p = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.retentionPreview', mode: 'ROLLING_DAYS', rollingDays: days });
      assert.ok(p.kind === 'guardian.retentionPreview'); return p;
    };
    const save = (key: string, days: number, version: string) => h.harness.cmd(h.guardianCtx, { kind: 'family.setRetention', idempotencyKey: key, target: { scope: 'FAMILY' }, payload: { mode: 'ROLLING_DAYS', rollingDays: days, confirmedPreviewVersion: version } });
    const first = await preview(30);
    const scope = { familyId: h.harness.familyId, actorId: h.guardianCtx.actorId };
    await h.harness.storage.tx('synthetic.retention.scope-change', async (r) => {
      await r.learningAttempt.insert(scope, { attemptId: 'old-terminal', familyId: scope.familyId, learnerId: h.learnerId, releaseId: SYNTH_RELEASE_ID,
        attemptStatus: 'COMPLETED', version: 1, previousAttemptId: null, startedAt: h.harness.clock.now() - 60 * DAY, endedAt: h.harness.clock.now() - 60 * DAY, resultSummaryJson: null });
    });
    assert.equal((await save('stale-scope', 30, first.previewVersion)).status, 'REJECTED');
    assert.equal((await save('edited-days', 31, first.previewVersion)).status, 'REJECTED');
    assert.equal((await save('foreign-version', 30, 'foreign-family-confirmation')).status, 'REJECTED');
    assert.equal((h.harness.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM retentionPolicy').get() as {n:number}).n, 0);
    const reviewed = await preview(30);
    assert.equal(reviewed.affectedAttempts[0].learnerAlias, '小测'); assert.equal(reviewed.affectedAttempts[0].status, 'COMPLETED');
    const concurrent = await preview(90);
    assert.equal((await save('first-save', 30, reviewed.previewVersion)).status, 'APPLIED');
    const stored = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.retentionPolicy' });
    assert.ok(stored.kind === 'guardian.retentionPolicy'); assert.equal(stored.policy?.rollingDays, 30); assert.equal(stored.policy?.previewVersion, reviewed.previewVersion);
    assert.equal(stored.lastCleanup, null); // Policy save never performs the startup sweep.
    assert.equal((await save('stale-policy-overwrite', 90, concurrent.previewVersion)).status, 'REJECTED');
    assert.equal((await h.harness.server.query(h.guardianCtx, { kind: 'guardian.retentionPolicy' }) as typeof stored).policy?.rollingDays, 30);
  } finally { await h.harness.closeAll(); }
});

test('retention: exact boundary/activity and active/paused/recent/other-family survivors match startup sweep; cleanup timestamp is factual', async () => {
  const h = await createReadyHarness(options());
  try {
    const now = h.harness.clock.now(), cutoff = now - 90 * DAY;
    const scope = { familyId: h.harness.familyId, actorId: h.guardianCtx.actorId };
    const records: Array<[string,LearningAttemptRecord['attemptStatus'],number,number|null,number]> = [
      ['eligible','COMPLETED',cutoff-DAY,cutoff-1,cutoff-2],
      ['boundary','COMPLETED',cutoff-DAY,cutoff,cutoff-2],
      ['recent-event','ABANDONED',cutoff-DAY,cutoff-1,cutoff+1],
      ['active','ACTIVE',cutoff-DAY,null,cutoff-DAY],
      ['paused','PAUSED',cutoff-DAY,null,cutoff-DAY],
      ['recent-start','CONTENT_BLOCKED',cutoff+1,null,cutoff-1],
    ];
    await h.harness.storage.tx('synthetic.retention.boundaries', async (r) => {
      for (const [id,status,start,end,event] of records) {
        await r.learningAttempt.insert(scope, { attemptId:id,familyId:scope.familyId,learnerId:h.learnerId,releaseId:SYNTH_RELEASE_ID,attemptStatus:status,version:1,previousAttemptId:null,startedAt:start,endedAt:end,resultSummaryJson:null });
        await r.learningEvent.append(scope, { attemptId:id,familyId:scope.familyId,commandKind:'learning.pauseAttempt',eventType:'SYNTHETIC_ACTIVITY',payloadJson:'{}',payloadVersion:'1',occurredAt:event });
      }
      const foreign = { familyId: 'family-other', actorId: 'actor-other' };
      await r.family.insert(foreign, {familyId:foreign.familyId,displayName:'另一合成家庭',createdAt:now});
      await r.learner.insert(foreign, {learnerId:'learner-other',familyId:foreign.familyId,alias:'另一个合成别名',goalNote:null,status:'ACTIVE',createdAt:now});
      await r.learningAttempt.insert(foreign, {attemptId:'foreign-old',familyId:foreign.familyId,learnerId:'learner-other',releaseId:SYNTH_RELEASE_ID,attemptStatus:'COMPLETED',version:1,previousAttemptId:null,startedAt:cutoff-DAY,endedAt:cutoff-DAY,resultSummaryJson:null});
    });
    const p = await h.harness.server.query(h.guardianCtx, {kind:'guardian.retentionPreview',mode:'ROLLING_DAYS',rollingDays:90});
    assert.ok(p.kind==='guardian.retentionPreview'); assert.deepEqual(p.affectedAttemptIds,['eligible']); assert.equal(p.cutoffAt,cutoff); assert.equal(p.affectedAttempts[0].lastActivityAt,cutoff-1);
    assert.ok(!JSON.stringify(p).includes('另一个合成别名'));
    const receipt=await h.harness.cmd(h.guardianCtx,{kind:'family.setRetention',idempotencyKey:'boundary-save',target:{scope:'FAMILY'},payload:{mode:'ROLLING_DAYS',rollingDays:90,confirmedPreviewVersion:p.previewVersion}});assert.equal(receipt.status,'APPLIED');
    const swept=await applyRollingRetention(h.harness.storage,{asOf:now,newOpId:()=> 'retention-sweep-boundary'});assert.deepEqual(swept.deletedAttempts,['eligible']);
    const ids=(h.harness.storage.rawDatabase().prepare('SELECT attemptId FROM learningAttempt ORDER BY attemptId').all() as {attemptId:string}[]).map(r=>r.attemptId);
    assert.deepEqual(ids,['active','boundary','foreign-old','paused','recent-event','recent-start']);
    const state=await h.harness.server.query(h.guardianCtx,{kind:'guardian.retentionPolicy'});assert.ok(state.kind==='guardian.retentionPolicy');assert.deepEqual(state.lastCleanup,{checkedAt:now,deletedAttemptCount:1});parsePublicProjection(state);
  } finally { await h.harness.closeAll(); }
});

test('retention: actual stored policy survives Host epoch restart and fresh guardian readback', async () => {
  const opts=options();const h=await createReadyHarness(opts);
  const p=await h.harness.server.query(h.guardianCtx,{kind:'guardian.retentionPreview',mode:'UNTIL_GUARDIAN_DELETES'});assert.ok(p.kind==='guardian.retentionPreview');
  const receipt=await h.harness.cmd(h.guardianCtx,{kind:'family.setRetention',idempotencyKey:'restart-policy',target:{scope:'FAMILY'},payload:{mode:'UNTIL_GUARDIAN_DELETES',confirmedPreviewVersion:p.previewVersion}});assert.equal(receipt.status,'APPLIED');
  await h.harness.closeAll();
  const reopened=await Harness.create({...opts,hostEpoch:'retention-restart-2'});
  try {await reopened.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});const ctx=await reopened.guardianContext();const state=await reopened.server.query(ctx,{kind:'guardian.retentionPolicy'});assert.ok(state.kind==='guardian.retentionPolicy');assert.equal(state.policy?.mode,'UNTIL_GUARDIAN_DELETES');assert.equal(state.policy?.rollingDays,null);assert.equal(state.policy?.previewVersion,p.previewVersion);}
  finally {await reopened.closeAll();}
});
