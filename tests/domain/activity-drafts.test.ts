import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {Harness,GUARDIAN_PASSPHRASE} from '../fixtures/harness';
import {applyReleaseStatusChange} from '../../modules/learning/maintenance';
import {DEFAULT_LEARNER_SESSION_TTL_MS} from '../../modules/learning/auth';
import type {ActivityState} from '../../modules/contracts/public/activity';
import type {PublicCommandEnvelope} from '../../modules/contracts/public/envelope';
import {ActivityDrafts,activityDraftKey,leaveActivityEditor} from '../../apps/web/src/studio/activity-drafts';
import {SessionCommands} from '../../apps/web/src/studio/session-recovery';

test('drafts: real local save before navigation preserves wording without submitting a prediction or evaluation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rondo-drafts-')),h=await Harness.create({dbFile:join(root,'learning.sqlite'),contentRoot:join(root,'content')});
 const values=new Map<string,string>(),store={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 const checks:string[]=[];
 try{
  const releaseId='rondo.mvp.ai-a7-r1';await h.content.loadRelease(resolve('dist/content'),releaseId);
  for(const to of ['REVIEWED','AVAILABLE'] as const)await applyReleaseStatusChange(h.storage,()=>h.clock.now(),{releaseId,to,reason:'drafts-synthetic-only'});
  await h.setupFamily('drafts-synthetic');const guardian=await h.guardianContext(),learnerId=await h.createLearner(guardian,'synthetic editor'),ctx=await h.enterLearner(learnerId);
  const start=await h.cmd(ctx,{kind:'learning.startAttempt',idempotencyKey:'draft-start',target:{scope:'LEARNER',learnerId},payload:{releaseId}}),attemptId=start.effectRefs.find(x=>x.startsWith('attempt:'))!.slice(8);
  const q=await h.server.query(ctx,{kind:'learning.questionView',attemptId});assert.equal(q.kind,'learning.questionView');if(q.kind!=='learning.questionView')throw Error('question');
  const identity={familyId:h.familyId,learnerId,attemptId,releaseId},basis={...identity,questionInstanceId:q.spec.questionInstanceId,version:1};
  const editor=new ActivityDrafts(identity,store);editor.readServer(basis,(q.spec.scene.state as ActivityState).draft);
  editor.edit('prediction','先把每一项说法与资料对照。');editor.edit('source','#include <iostream>\nint main(){std::cout << 3;}');editor.edit('stdin','3\n');
  let calls=0,lose=false;
  const client={command:async(envelope:PublicCommandEnvelope)=>{calls++;const session=await h.auth.session();if(!session?.learnerId)throw Object.assign(Error('session expired'),{code:'UNAUTHENTICATED'});
   const receipt=await h.server.handleCommand(await h.learnerContext(session.learnerId),envelope);if(lose){lose=false;throw Object.assign(Error('lost after commit'),{transport:'RECEIPT_UNKNOWN'});}return receipt;}};
  const commands=new SessionCommands({auth:h.auth,client},identity,store);
  const read=async(ownSaved?:ActivityState['draft'])=>{const current=await h.server.query(await h.learnerContext(learnerId),{kind:'learning.questionView',attemptId}),view=await h.server.query(await h.learnerContext(learnerId),{kind:'learning.attemptView',attemptId});if(current.kind!=='learning.questionView'||view.kind!=='learning.attemptView')throw Error('readback');editor.readServer({...basis,version:view.version},(current.spec.scene.state as ActivityState).draft,ownSaved);};
  const save=async()=>{const draft={...editor.getSnapshot().draft!};const view=await h.server.query(await h.learnerContext(learnerId),{kind:'learning.attemptView',attemptId});if(view.kind!=='learning.attemptView')throw Error('view');
   const receipt=await commands.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft}},{scope:'LEARNER',learnerId,attemptId},view.version,{releaseId,questionInstanceId:basis.questionInstanceId,rendererContractVersion:'1'});if(receipt)await read(draft);return receipt;};
  const state=()=>({...editor.getSnapshot(),pending:!!commands.getSnapshot().pending,busy:commands.getSnapshot().busy,needsReentry:commands.getSnapshot().needsReentry,active:true});
  assert.equal(await leaveActivityEditor({state,save,notice:editor.note}),true);assert.equal(calls,1);assert.equal(editor.getSnapshot().dirty,false);assert.equal(values.has(activityDraftKey(learnerId)),false);
  assert.equal(h.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM prediction').get()!.n,0);assert.equal(h.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM evaluation').get()!.n,0);
  checks.push('one applied SaveActivityDraft before leaving; exact wording/code/input stored; no prediction, submission or scoring fabricated');
  editor.edit('explanation','第一次尝试保存这一句。');lose=true;assert.equal(await leaveActivityEditor({state,save,notice:editor.note}),false);const original=commands.getSnapshot().pending!;
  editor.edit('explanation','回执未知后继续写的新一句。');
  h.clock.advance(DEFAULT_LEARNER_SESSION_TTL_MS+1);await commands.retry();assert.equal(commands.getSnapshot().needsReentry,true);
  const recovered=await commands.reenterAndRetry(GUARDIAN_PASSPHRASE);assert.equal(recovered.receipt?.status,'APPLIED');assert.equal(commands.getSnapshot().pending,null);
  await read();assert.equal(editor.getSnapshot().draft!.explanation,'回执未知后继续写的新一句。');assert.equal(editor.getSnapshot().dirty,true);assert.equal(editor.getSnapshot().retainedDraft,null);
  const fresh=new ActivityDrafts(identity,store);const view=await h.server.query(await h.learnerContext(learnerId),{kind:'learning.attemptView',attemptId}),question=await h.server.query(await h.learnerContext(learnerId),{kind:'learning.questionView',attemptId});if(view.kind!=='learning.attemptView'||question.kind!=='learning.questionView')throw Error('fresh');fresh.readServer({...basis,version:view.version},(question.spec.scene.state as ActivityState).draft);
  assert.equal(fresh.getSnapshot().draft!.explanation,'回执未知后继续写的新一句。');
  assert.equal(h.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM commandReceipt WHERE idempotencyKey = ?').get(original.idempotencyKey)!.n,1);
  assert.equal(h.storage.rawDatabase().prepare("SELECT COUNT(*) n FROM learningEvent WHERE eventType='OPERATION_COMMITTED' AND attemptId = ?").get(attemptId)!.n,2);
  checks.push('lost response + real learner TTL + existing reentry uses original key exactly once; newer local edit survives both readback and remount');
  assert.ok([...values.values()].every(text=>!text.includes(GUARDIAN_PASSPHRASE)));
  await writeFile(join(root,'RESULT.json'),JSON.stringify({status:'PASS',checks,root},null,2)+'\n');
 }catch(error){await writeFile(join(root,'FAILURE.txt'),String(error));throw error;}
 finally{await h.closeAll();}
});
