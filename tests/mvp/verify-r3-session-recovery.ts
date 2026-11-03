import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Harness,GUARDIAN_PASSPHRASE} from '../fixtures/harness';
import {DEFAULT_LEARNER_SESSION_TTL_MS} from '../../modules/learning/auth';
import {applyReleaseStatusChange} from '../../modules/learning/maintenance';
import {SessionCommands} from '../../apps/web/src/studio/session-recovery';
import type {ActivityState} from '../../modules/contracts/public/activity';
import type {PublicCommandEnvelope} from '../../modules/contracts/public/envelope';
import type {LocalAuthPort} from '../../modules/contracts/public/auth';
const root=mkdtempSync(resolve('.synthetic-data-r3-recovery-')),h=await Harness.create({dbFile:root+'/learning.sqlite',contentRoot:root+'/content'});
const report:{status?:string;checks:string[];calls:unknown[];dataRoot:string;error?:string}={checks:[],calls:[],dataRoot:root};
const values=new Map<string,string>(),store={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
let loseAfterCommit=false;
try{
 const releaseId='rondo.mvp.ai-a7-r1';await h.content.loadRelease(resolve('dist/content'),releaseId);for(const to of ['REVIEWED','AVAILABLE']as const)await applyReleaseStatusChange(h.storage,()=>h.clock.now(),{releaseId,to,reason:'r3-synthetic-session-recovery'});
 await h.setupFamily('r3');let guardian=await h.guardianContext();const learnerId=await h.createLearner(guardian,'original'),otherLearnerId=await h.createLearner(guardian,'other');let ctx=await h.enterLearner(learnerId);
 const start=await h.server.handleCommand(ctx,h.envelope({kind:'learning.startAttempt',idempotencyKey:'r3-start',target:{scope:'LEARNER',learnerId},payload:{releaseId}}));const attemptId=start.effectRefs.find(x=>x.startsWith('attempt:'))!.slice(8);
 await h.server.handleCommand(ctx,h.envelope({kind:'learning.recordPrediction',idempotencyKey:'r3-predict',target:{scope:'LEARNER',learnerId,attemptId},payload:{prediction:{kind:'activity.statement.v1',activityId:'ai-a7',statement:'我要把每项说法与资料对照。'},uncertain:false}}));
 const q=await h.server.query(ctx,{kind:'learning.questionView',attemptId});if(q.kind!=='learning.questionView')throw Error('question');
 const identity={familyId:h.familyId,learnerId},target={scope:'LEARNER',learnerId,attemptId},binding={releaseId,questionInstanceId:q.spec.questionInstanceId,rendererContractVersion:'1'};
 const draft:ActivityState['draft']={...(q.spec.scene.state as ActivityState).draft,answerText:JSON.stringify({hours:'conflict',animals:'conflict',bus:'insufficient'}),explanation:'我还没有保存的解释也留在当前页面。'};const draftReference=draft;
 const calls:PublicCommandEnvelope[]=[];
 const client={command:async(envelope:PublicCommandEnvelope)=>{
  calls.push(envelope);report.calls.push(envelope);
  const current=await h.auth.session();if(!current||current.role!=='LEARNER')throw Object.assign(new Error('expired'),{code:'UNAUTHENTICATED'});
  const currentCtx=await h.learnerContext(current.learnerId!);const receipt=await h.server.handleCommand(currentCtx,envelope);
  if(loseAfterCommit){loseAfterCommit=false;throw Object.assign(new Error('reply lost after commit'),{code:'HOST_RECOVERING',transport:'RECEIPT_UNKNOWN'});}return receipt;
 }};
 const commands=new SessionCommands({auth:h.auth,client},identity,store);
 h.clock.advance(DEFAULT_LEARNER_SESSION_TTL_MS+1);
 const first=await commands.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft}},target,2,binding);
 assert.equal(first,null);assert.equal(commands.getSnapshot().needsReentry,true);const original=commands.getSnapshot().pending!;assert.ok(original);assert.equal(calls.length,0);
 const encoded=values.get('rondo.mvp.pending.'+learnerId)!;
 const wrong=await commands.reenterAndRetry('incorrect-password');assert.equal(wrong.reentered,false);assert.equal(commands.getSnapshot().pending,original);assert.equal(draft,draftReference);assert.equal(draft.answerText,JSON.stringify({hours:'conflict',animals:'conflict',bus:'insufficient'}));assert.equal(calls.length,0);assert.equal(values.get('rondo.mvp.pending.'+learnerId),encoded);assert.equal(commands.getSnapshot().recoveryNote,'');
 report.checks.push('15-minute real auth TTL expires using deterministic clock; unsaved choices and original pending remain; wrong password neither replays nor reports saved');
 const restored=await commands.reenterAndRetry(GUARDIAN_PASSPHRASE);assert.equal(restored.reentered,true);assert.equal(restored.receipt?.status,'APPLIED');assert.deepEqual(calls[0],original);assert.equal(commands.getSnapshot().pending,null);assert.equal(draft,draftReference);
 ctx=await h.learnerContext(learnerId);let question=await h.server.query(ctx,{kind:'learning.questionView',attemptId});assert.equal(question.kind==='learning.questionView'&&(question.spec.scene.state as ActivityState).draft.answerText,draft.answerText);
 assert.equal(h.storage.rawDatabase().prepare("SELECT count(*) n FROM learningEvent WHERE attemptId=? AND eventType='OPERATION_COMMITTED'").get(attemptId)!['n'],1);
 report.checks.push('same actual product re-entry callback uses existing guardian unlock and original learner; original envelope saves once in the same attempt with draft intact');
 // A second write commits but its response is lost. Expire before confirming it.
 const changed={...draft,explanation:'后来新增的一句解释。'};loseAfterCommit=true;
 await commands.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:changed}},target,3,binding);const committedPending=commands.getSnapshot().pending!;assert.ok(committedPending);
 h.clock.advance(DEFAULT_LEARNER_SESSION_TTL_MS+1);await commands.retry();assert.equal(commands.getSnapshot().needsReentry,true);
 const recovered=await commands.reenterAndRetry(GUARDIAN_PASSPHRASE);assert.equal(recovered.receipt?.status,'APPLIED');assert.deepEqual(calls.at(-1),committedPending);assert.equal(h.storage.rawDatabase().prepare("SELECT count(*) n FROM learningEvent WHERE attemptId=? AND eventType='OPERATION_COMMITTED'").get(attemptId)!['n'],2);
 assert.equal(h.storage.rawDatabase().prepare('SELECT count(*) n FROM commandReceipt WHERE idempotencyKey=?').get(committedPending.idempotencyKey)!['n'],1);
 report.checks.push('committed-but-lost reply followed by expiry replays the original key under the stable learner actor; one receipt and no duplicate operation');
 // Current identity changed to a sibling: no pending request is sent there.
 await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});await h.auth.enterLearner({learnerId:otherLearnerId});
 const beforeWrongLearner=calls.length;await commands.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft}},target,4,binding);assert.equal(calls.length,beforeWrongLearner);assert.equal(commands.getSnapshot().needsReentry,true);const scoped=commands.getSnapshot().pending!;
 const oldStore=new Map(values);const otherFamily=new SessionCommands({auth:h.auth,client},{familyId:'foreign-family',learnerId},store);await otherFamily.retry();assert.equal(calls.length,beforeWrongLearner);assert.equal(otherFamily.getSnapshot().errorCode,'FORBIDDEN');assert.deepEqual(values,oldStore);
 const wrongAuth:LocalAuthPort={...h.auth,unlockGuardian:async input=>({...await h.auth.unlockGuardian(input),familyId:'foreign-family'})};const wrongFamily=new SessionCommands({auth:wrongAuth,client},identity,store);await wrongFamily.reenterAndRetry(GUARDIAN_PASSPHRASE);assert.equal(calls.length,beforeWrongLearner);assert.equal(wrongFamily.getSnapshot().pending?.idempotencyKey,scoped.idempotencyKey);
 const correct=await commands.reenterAndRetry(GUARDIAN_PASSPHRASE);assert.equal(correct.receipt?.status,'APPLIED');assert.equal((await h.auth.session())?.learnerId,learnerId);
 assert.ok([...values.values()].every(text=>!text.includes(GUARDIAN_PASSPHRASE)&&!text.includes('incorrect-password')));
 report.checks.push('sibling learner and foreign family cannot replay; original learner re-entry restores the original request; no plaintext password persisted');
 // Read failures can request re-entry without creating a write or changing any editor.
 const readRecovery=new SessionCommands({auth:h.auth,client},identity,store);readRecovery.reportFailure({code:'UNAUTHENTICATED',message:'expired read'});const beforeRead=calls.length;const reentered=await readRecovery.reenterAndRetry(GUARDIAN_PASSPHRASE);assert.equal(reentered.reentered,true);assert.equal(reentered.receipt,null);assert.equal(calls.length,beforeRead);assert.equal(draft,draftReference);
 report.checks.push('auth-expired reads re-enter in place without fabricating a save or creating a request');report.status='PASS';
}catch(e){report.status='FAIL';report.error=e instanceof Error?e.stack:String(e);throw e;}finally{writeFileSync(resolve('../delivery/r3/session-recovery-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks,error:report.error}));await h.closeAll();}
