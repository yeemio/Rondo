import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {renderToStaticMarkup} from 'react-dom/server';
import {Harness,GUARDIAN_PASSPHRASE} from '../fixtures/harness';
import {applyReleaseStatusChange} from '../../modules/learning/maintenance';
import {MATH_ACTIVITIES,MATH_LEGACY_ACTIVITIES} from '../../modules/curriculum/math6';
import {GESP_ACTIVITIES,GESP_LEGACY_ACTIVITIES} from '../../modules/curriculum/gesp';
import type {ActivityState,ActivityHistory} from '../../modules/contracts/public/activity';
import type {CommandKind} from '../../modules/contracts/public/envelope';
import type {ServerContext} from '../../modules/contracts/server/context';
import {ActivityHistoryPanel} from '../../apps/web/src/app/Mvp';

async function releases(h:Harness,ids:string[]){for(const releaseId of ids){await h.content.loadRelease(resolve('dist/content'),releaseId);if(h.content.releaseStatus(releaseId)==='DRAFT')await applyReleaseStatusChange(h.storage,()=>h.clock.now(),{releaseId,to:'REVIEWED',reason:'synthetic p0 verification'});if(h.content.releaseStatus(releaseId)==='REVIEWED')await applyReleaseStatusChange(h.storage,()=>h.clock.now(),{releaseId,to:'AVAILABLE',reason:'synthetic p0 verification'});}}
function driver(h:Harness,learnerId:string,ctx:ServerContext,tag:string){
 let serial=0;const target={attemptId:'',releaseId:''};
 async function view(){const v=await h.server.query(ctx,{kind:'learning.attemptView',attemptId:target.attemptId}),q=await h.server.query(ctx,{kind:'learning.questionView',attemptId:target.attemptId});assert.equal(v.kind,'learning.attemptView');assert.equal(q.kind,'learning.questionView');if(v.kind!=='learning.attemptView'||q.kind!=='learning.questionView')throw Error('unexpected view');return{v,q,state:q.spec.scene.state as ActivityState};}
 async function send(kind:CommandKind,payload:unknown,accept=true){const current=target.attemptId?await view():null;const envelope=h.envelope({kind,payload,idempotencyKey:tag+'-'+ ++serial,target:{scope:'LEARNER',learnerId,...(target.attemptId?{attemptId:target.attemptId}:{})},...(current?{expectedAttemptVersion:current.v.version,binding:{releaseId:target.releaseId,questionInstanceId:current.q.spec.questionInstanceId,rendererContractVersion:'1'}}:{})});const receipt=await h.server.handleCommand(ctx,envelope);if(accept)assert.equal(receipt.status,'APPLIED',JSON.stringify(receipt));return receipt;}
 async function start(releaseId:string){target.releaseId=releaseId;target.attemptId='';const r=await send('learning.startAttempt',{releaseId});target.attemptId=r.effectRefs.find(x=>x.startsWith('attempt:'))!.slice(8);return target.attemptId;}
 async function history(){const r=await h.server.query(ctx,{kind:'learning.activityHistory',learnerId});assert.equal(r.kind,'learning.activityHistory');return r as ActivityHistory;}
 async function predict(activityId='math6'){await send('learning.recordPrediction',{prediction:{kind:'activity.statement.v1',activityId,statement:'合成验证：先列条件，再用记录检查。'},uncertain:false});}
 const set=(controlId:string,value:number)=>send('learning.commitOperation',{operation:{type:'SetMathControl',controlId,value}});
 const capture=()=>send('learning.commitOperation',{operation:{type:'CaptureMathTrial'}});
 async function finish(){await send('learning.beginExplanation',{});await send('learning.saveExplanation',{selections:[],freeText:'合成解释：只引用本次已保存的模型状态和公开前提，不把流程结束当作掌握。',transcribedByGuardian:false});await send('learning.finishAttempt',{});}
 return{target,view,send,start,history,predict,set,capture,finish};
}
const quantity=(id:string,value:string,unit:string)=>({kind:'quantity',id,value:{kind:'decimal',value},unit});
const circleAnswer={response:[{kind:'mathAnswer',version:'math.answers.v1',lessonId:'math6.b16',answers:[quantity('q1','6','厘米'),quantity('q2','1.5','厘米')]}]};

test('actual auth/domain/SQLite: empty construction and arbitrary captures cannot enter completion',async()=>{
 const h=await Harness.create({policy:{courseGraph:[],hintPolicy:[],defaultRetention:{mode:'UNTIL_GUARDIAN_DELETES'}}});
 try{
  await releases(h,['rondo.mvp.math6-b16-r2','rondo.mvp.math6-u7-05-r2','rondo.mvp.gesp2-202606-tf09-r2']);await h.setupFamily('p0-synthetic');const learner=await h.createLearner(await h.guardianContext(),'合成P0学习者'),d=driver(h,learner,await h.enterLearner(learner),'p0-new');
  await d.start('rondo.mvp.math6-b16-r2');await d.predict();await d.capture();
  assert.equal((await d.send('learning.submitResponse',circleAnswer,false)).status,'REJECTED');assert.equal((await d.view()).v.currentCycle!.phase,'OPERATE');
  assert.equal((await d.send('learning.beginExplanation',{},false)).status,'REJECTED');assert.equal((await d.send('learning.finishAttempt',{},false)).status,'REJECTED');
  let c=(await d.history()).attempts.find(a=>a.attemptId===d.target.attemptId)!.cycles[0];assert.equal(c.submissions.length,0);
  await d.set('radius',3);await d.capture();await d.set('radius',1.5);await d.capture();const before=(await d.view()).state;
  assert.equal((await d.send('learning.commitOperation',{operation:{type:'SetMathControl',controlId:'radius',value:1.55}},false)).status,'REJECTED');assert.deepEqual((await d.view()).state,before);
  await d.send('learning.submitResponse',circleAnswer);c=(await d.history()).attempts.find(a=>a.attemptId===d.target.attemptId)!.cycles[0];assert.equal(c.submissions[0].outcome,'CORRECT');assert.equal((c.submissions[0].feedback as {reveal?:unknown}).reveal,undefined);await d.finish();
  await d.start('rondo.mvp.math6-u7-05-r2');await d.predict();await d.capture();await d.send('learning.commitOperation',{operation:{type:'RecordMathObservation',text:'合成位置(3,4)，统一原点、方向和单位。'}});
  const response={response:[{kind:'mathAnswer',version:'math.answers.v1',lessonId:'math6.u7-05',answers:[]}]};assert.equal((await d.send('learning.submitResponse',response,false)).status,'REJECTED');await d.set('positionView',1);await d.capture();await d.send('learning.submitResponse',response);c=(await d.history()).attempts.find(a=>a.attemptId===d.target.attemptId)!.cycles[0];assert.equal(c.submissions[0].outcome,'UNSCORABLE');assert.equal((c.submissions[0].feedback as {assessmentMode:{mode:string}}).assessmentMode.mode,'OBSERVATION_RECORDED');await d.finish();
  await d.start('rondo.mvp.gesp2-202606-tf09-r2');await d.predict('gesp-objective');for(const fieldId of ['given','steps','check'])await d.send('learning.commitOperation',{operation:{type:'RecordGespReasoning',fieldId,text:'合成边界：32位int输入1000000000的最后位权更新超范围。'}});
  await d.send('learning.submitResponse',{response:[{kind:'singleChoice',selectionId:'gesp2.202606.tf09',optionId:'ISSUE'}]});c=(await d.history()).attempts.find(a=>a.attemptId===d.target.attemptId)!.cycles[0];assert.equal(c.submissions[0].outcome,'UNSCORABLE');assert.equal((c.submissions[0].feedback as {assessmentMode:{mode:string}}).assessmentMode.mode,'ISSUE_RECORDED');assert.deepEqual((c.submissions[0].feedback as {itemResults:unknown[]}).itemResults,[]);assert.equal((c.submissions[0].feedback as {reveal?:unknown}).reveal,undefined);await d.finish();
  const markup=renderToStaticMarkup(<ActivityHistoryPanel history={await d.history()}/>);assert.match(markup,/局部填空未核对/);assert.match(markup,/观察已记录/);
 }finally{await h.closeAll();}
});

test('original baseline attempts survive r2 registration and SQLite reopen without history rewriting',{skip:!process.env.RONDO_P0_BASELINE_HARNESS},async()=>{
 const baseline=await import(pathToFileURL(resolve(process.env.RONDO_P0_BASELINE_HARNESS!)).href) as typeof import('../fixtures/harness');
 const root=await mkdtemp(join(tmpdir(),'rondo-p0-upgrade-')),options={dbFile:join(root,'learning.sqlite'),contentRoot:join(root,'content'),policy:{courseGraph:[],hintPolicy:[],defaultRetention:{mode:'UNTIL_GUARDIAN_DELETES' as const}}};
 let h=await baseline.Harness.create(options);let learner='',before:ActivityHistory,pausedId='';
 try{
  await releases(h,['rondo.mvp.math6-b16-r1','rondo.mvp.math6-u1-11-r1','rondo.mvp.gesp2-202606-tf09-r1']);await h.setupFamily('p0-old-synthetic');learner=await h.createLearner(await h.guardianContext(),'合成旧版学习者');let d=driver(h,learner,await h.enterLearner(learner),'p0-baseline');
  await d.start('rondo.mvp.math6-b16-r1');await d.predict();await d.capture();await d.send('learning.submitResponse',circleAnswer);await d.finish();
  await d.start('rondo.mvp.gesp2-202606-tf09-r1');await d.predict('gesp-objective');for(const fieldId of ['given','steps','check'])await d.send('learning.commitOperation',{operation:{type:'RecordGespReasoning',fieldId,text:'合成旧版推演：小整数还原与大整数位权边界。'}});await d.send('learning.submitResponse',{response:[{kind:'singleChoice',selectionId:'gesp2.202606.tf09',optionId:'T'}]});await d.finish();
  pausedId=await d.start('rondo.mvp.math6-u1-11-r1');await d.predict();await d.capture();const oldState=(await d.view()).state;await d.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:{...oldState.draft,answerText:'{"q1":"20"}',explanation:'合成旧版草稿，保留0.45模型与题面不一致的发现。'}}});await d.send('learning.pauseAttempt',{});before=await d.history();await h.closeAll();
  h=await Harness.create(options);await releases(h,[...MATH_ACTIVITIES,...MATH_LEGACY_ACTIVITIES,...GESP_ACTIVITIES,...GESP_LEGACY_ACTIVITIES].filter(a=>a.releaseId.endsWith('r2')||[...MATH_LEGACY_ACTIVITIES,...GESP_LEGACY_ACTIVITIES].some(old=>old.releaseId===a.releaseId)).map(a=>a.releaseId));await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});d=driver(h,learner,await h.enterLearner(learner),'p0-upgraded');
  assert.deepEqual(await d.history(),before);const markup=renderToStaticMarkup(<ActivityHistoryPanel history={before}/>);assert.match(markup,/旧版记录/);assert.match(markup,/0\.45/);assert.match(markup,/不代表已满足新版要求/);
  d.target.attemptId=pausedId;d.target.releaseId='rondo.mvp.math6-u1-11-r1';await d.send('learning.resumeAttempt',{});assert.equal((await d.view()).state.draft.answerText,'{"q1":"20"}');await d.send('learning.pauseAttempt',{});
  const resumedHistory=await d.history();assert.deepEqual(resumedHistory.attempts.map(a=>a.cycles),before.attempts.map(a=>a.cycles));
  d.target.attemptId='';assert.equal((await d.send('learning.startAttempt',{releaseId:'rondo.mvp.math6-b16-r1'},false)).status,'REJECTED');
  d.target.attemptId=before.attempts.find(a=>a.releaseId==='rondo.mvp.math6-b16-r1')!.attemptId;d.target.releaseId='rondo.mvp.math6-b16-r1';assert.equal((await d.send('learning.finishAttempt',{},false)).status,'REJECTED');
  await d.start('rondo.mvp.math6-u1-11-r2');assert.equal((await d.view()).state.math?.trials.length,0);assert.equal((await d.view()).state.draft.answerText,'{}');assert.notEqual(d.target.attemptId,pausedId);await d.send('learning.pauseAttempt',{});const after=await d.history();assert.deepEqual(after.attempts.filter(a=>before.attempts.some(b=>a.attemptId===b.attemptId)).map(a=>a.cycles),before.attempts.map(a=>a.cycles));
  await h.closeAll();h=await Harness.create(options);await releases(h,['rondo.mvp.math6-b16-r1','rondo.mvp.math6-u1-11-r1','rondo.mvp.math6-u1-11-r2','rondo.mvp.gesp2-202606-tf09-r1']);await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});d=driver(h,learner,await h.enterLearner(learner),'p0-reopened');assert.deepEqual(await d.history(),after);
 }finally{await h.closeAll();await rm(root,{recursive:true,force:true});}
});
