import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Harness} from '../fixtures/harness';
import {MVP_ACTIVITIES} from '../../modules/curriculum/mvp';
import {submitActivityPrediction,activityPredictionPayload} from '../../apps/web/src/studio/prediction';
import {parseEnvelope} from '../../modules/contracts/public/envelope';
import {applyReleaseStatusChange} from '../../modules/learning/maintenance';
import type {ActivityState} from '../../modules/contracts/public/activity';
const root=mkdtempSync(resolve('.synthetic-data-r2-prediction-'));
const h=await Harness.create({dbFile:root+'/learning.sqlite',contentRoot:root+'/content'}),report:{checks:string[];requests:unknown[];status?:string}={checks:[],requests:[]};
try{
 await h.setupFamily('r2-prediction');const guardian=await h.guardianContext(),learnerId=await h.createLearner(guardian,'synthetic-ui-callback'),ctx=await h.enterLearner(learnerId);let seq=0;
 for(const a of MVP_ACTIVITIES){
  await h.content.loadRelease(resolve('dist/content'),a.releaseId);for(const to of ['REVIEWED','AVAILABLE'] as const)await applyReleaseStatusChange(h.storage,()=>Date.now(),{releaseId:a.releaseId,to,reason:'r2-prediction-verification'});
  const start=await h.server.handleCommand(ctx,h.envelope({kind:'learning.startAttempt',payload:{releaseId:a.releaseId},target:{scope:'LEARNER',learnerId},idempotencyKey:'start-'+a.id}));assert.equal(start.status,'APPLIED');const attemptId=start.effectRefs.find(x=>x.startsWith('attempt:'))!.slice(8);
  const q=await h.server.query(ctx,{kind:'learning.questionView',attemptId});if(q.kind!=='learning.questionView')throw Error('question');const binding={releaseId:a.releaseId,questionInstanceId:q.spec.questionInstanceId,rendererContractVersion:'1'},target={scope:'LEARNER' as const,learnerId,attemptId};
  const statement=a.id==='ratio'?'橙汁与水是3比2，两种杯数一起加倍后味道不变。':a.id==='cpp'?'字母下一行从前一行后面接着写，不应每行从A重新开始。':'每天开放和一定能到，都还需要查资料。';
  const bad=h.envelope({kind:'learning.recordPrediction',payload:activityPredictionPayload(a.id==='ratio'?'cpp':'ratio',statement,false),target,binding,idempotencyKey:'wrong-activity-'+a.id});assert.equal((await h.server.handleCommand(ctx,bad)).status,'REJECTED');
  const before=h.storage.rawDatabase().prepare('SELECT count(*) n FROM prediction').get()!['n'];
  const draft={...(q.spec.scene.state as ActivityState).draft,prediction:statement,uncertain:false};let version=1;
  const result=await submitActivityPrediction({activityId:a.id,draft,save:async()=>{const r=await h.server.handleCommand(ctx,h.envelope({kind:'learning.commitOperation',payload:{operation:{type:'SaveActivityDraft',draft}},target,binding,expectedAttemptVersion:version,idempotencyKey:'ui-save-'+a.id}));assert.equal(r.status,'APPLIED');version=r.attemptVersion!;return r;},send:async(kind,payload,currentVersion)=>{const envelope=h.envelope({kind,payload,target,binding,expectedAttemptVersion:currentVersion,idempotencyKey:'ui-form-'+a.id});report.requests.push(envelope);return h.server.handleCommand(ctx,envelope);}});
  assert.equal(result?.status,'APPLIED');
  const row=h.storage.rawDatabase().prepare('SELECT contentJson,uncertain FROM prediction WHERE cycleId=?').get((q.spec.questionInstanceId&&start.effectRefs.find(x=>x.startsWith('cycle:'))!.slice(6)))!;
  assert.deepEqual(JSON.parse(String(row['contentJson'])),{kind:'activity.statement.v1',activityId:a.id,statement});assert.equal(row['uncertain'],0);
  const av=await h.server.query(ctx,{kind:'learning.attemptView',attemptId});assert.equal(av.kind==='learning.attemptView'&&av.currentCycle?.phase,'OPERATE');
  const replay=await h.server.handleCommand(ctx,report.requests.at(-1) as ReturnType<typeof parseEnvelope>);assert.deepEqual(replay,result);
  assert.equal(h.storage.rawDatabase().prepare('SELECT count(*) n FROM prediction').get()!['n'],Number(before)+1);
  const overwrite=await h.server.handleCommand(ctx,h.envelope({kind:'learning.recordPrediction',payload:activityPredictionPayload(a.id,'changed later',false),target,binding,idempotencyKey:'overwrite-'+a.id}));assert.equal(overwrite.status,'REJECTED');
  const history=await h.server.query(ctx,{kind:'learning.activityHistory',learnerId});assert.equal(history.kind==='learning.activityHistory'&&(history.attempts.at(-1)!.cycles[0].prediction as {content:{statement:string}}).content.statement,statement);
  await h.server.handleCommand(ctx,h.envelope({kind:'learning.endWithoutCompleting',payload:{confirmAbandon:true},target,idempotencyKey:'end-'+a.id}));
  report.checks.push(a.id+': actual shared UI submit callback saves exact confident statement, uncertain=false, enters OPERATE; mismatched activity and overwrite rejected; replay one prediction');seq++;
 }
 const target={scope:'LEARNER' as const,learnerId};
 const make=(prediction:unknown,uncertain=false)=>()=>parseEnvelope(h.envelope({kind:'learning.recordPrediction',payload:{prediction,uncertain},target,idempotencyKey:'negative'}));
 assert.throws(make({claims:[]}));assert.doesNotThrow(make({claims:[]},true));
 assert.throws(make({kind:'activity.statement.v2',activityId:'ratio',statement:'claim'}));assert.throws(make({kind:'activity.statement.v1',activityId:'unknown',statement:'claim'}));assert.throws(make({kind:'activity.statement.v1',activityId:'ratio',statement:'   '}));assert.throws(make({kind:'activity.statement.v1',activityId:'ratio',statement:'😀'.repeat(1600)}));
 assert.deepEqual(activityPredictionPayload('ratio','  保留我的原文。  ',true),{prediction:{kind:'activity.statement.v1',activityId:'ratio',statement:'  保留我的原文。  '},uncertain:true});
 assert.equal(h.storage.rawDatabase().prepare('SELECT count(*) n FROM evaluation').get()!['n'],0);
 report.checks.push('old empty-claims rejection retained; explicit uncertainty allowed; unknown version/activity, blank and UTF-8 overflow rejected; no evaluation created');report.status='PASS';
}catch(e){report.status='FAIL';throw e;}finally{writeFileSync(resolve('../delivery/r2/prediction-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks}));await h.closeAll();}
