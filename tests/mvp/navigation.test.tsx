import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {renderToStaticMarkup} from 'react-dom/server';
import {Harness} from '../fixtures/harness';
import {applyReleaseStatusChange} from '../../modules/learning/maintenance';
import {MATH_ACTIVITIES,MATH_LESSONS} from '../../modules/curriculum/math6';
import {AI_ACTIVITIES} from '../../modules/curriculum/mvp';
import {GESP_LESSONS} from '../../modules/curriculum/gesp';
import type {RondoClient} from '../../modules/contracts/public/client';
import type {PublicCommandEnvelope,CommandKind} from '../../modules/contracts/public/envelope';
import type {ActivityState} from '../../modules/contracts/public/activity';
import {SessionCommands} from '../../apps/web/src/studio/session-recovery';
import {enterSelectedCourse,readCourseNavigation,restoreCatalogueSelection} from '../../apps/web/src/studio/course-navigation';
import {MathCatalogue} from '../../apps/web/src/studio/Math6';
import {GespCatalogue} from '../../apps/web/src/studio/Gesp';
import {MvpHome} from '../../apps/web/src/app/Mvp';
import type {AppPorts} from '../../apps/web/src/client/ports';
const A=MATH_ACTIVITIES[0],B=MATH_ACTIVITIES[1],C=AI_ACTIVITIES[0];
function store(){const values=new Map<string,string>();return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
async function setup(){
 const parent=resolve('../synthetic-data');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'navigation-'));
 const h=await Harness.create({dbFile:root+'/learning.sqlite',contentRoot:root+'/content'});
 for(const activity of [A,B,C]){await h.content.loadRelease(resolve('dist/content'),activity.releaseId);for(const to of ['REVIEWED','AVAILABLE'] as const)await applyReleaseStatusChange(h.storage,()=>h.clock.now(),{releaseId:activity.releaseId,to,reason:'navigation-only-synthetic'});}
 await h.setupFamily('navigation-synthetic');const guardian=await h.guardianContext(),learnerId=await h.createLearner(guardian,'合成选课学习者'),ctx=await h.enterLearner(learnerId);
 const requests:PublicCommandEnvelope[]=[];let loseKind:CommandKind|null=null;
 const client:RondoClient={query:q=>h.server.query(ctx,q),receipt:q=>h.server.lookupReceipt(ctx,q),subscribeInvalidation:()=>()=>{},command:async e=>{requests.push(e);const receipt=await h.server.handleCommand(ctx,e);if(loseKind===e.kind){loseKind=null;throw Object.assign(new Error('reply lost after commit'),{code:'HOST_RECOVERING',transport:'RECEIPT_UNKNOWN'});}return receipt;}};
 const memory=store(),commands=new SessionCommands({auth:h.auth,client},{familyId:h.familyId,learnerId},memory);
 const choose=(releaseId:string,reviewedActiveId:string|null)=>enterSelectedCourse({client,send:commands.send,learnerId,releaseId,reviewedActiveId});
 const view=async(attemptId:string)=>{const v=await h.server.query(ctx,{kind:'learning.attemptView',attemptId});assert.ok(v.kind==='learning.attemptView');return v;};
 const question=async(attemptId:string)=>{const q=await h.server.query(ctx,{kind:'learning.questionView',attemptId});assert.ok(q.kind==='learning.questionView');return q.spec;};
 return {h,guardian,learnerId,ctx,client,commands,requests,choose,view,question,memory,lose:(kind:CommandKind)=>{loseKind=kind;}};
}

test('navigation opens actual selected lessons, keeps several paused records, and resumes original phase/draft without ending old work',async()=>{
 const f=await setup();try{
  const a=await f.choose(A.releaseId,null);assert.ok(a);assert.equal(a.releaseId,A.releaseId);
  assert.deepEqual(await f.choose(A.releaseId,null),a);assert.equal(f.requests.filter(e=>e.kind==='learning.startAttempt').length,1);
  const q=await f.question(a.attemptId),draft={...(q.scene.state as ActivityState).draft,prediction:'合成猜想会保留',explanation:'尚未提交的合成解释'};
  const saved=await f.h.server.handleCommand(f.ctx,f.h.envelope({kind:'learning.commitOperation',idempotencyKey:'nav-draft',target:{scope:'LEARNER',learnerId:f.learnerId,attemptId:a.attemptId},payload:{operation:{type:'SaveActivityDraft',draft}},binding:{releaseId:A.releaseId,questionInstanceId:q.questionInstanceId,rendererContractVersion:'1'},expectedAttemptVersion:1}));assert.equal(saved.status,'APPLIED');
  const prediction=await f.h.server.handleCommand(f.ctx,f.h.envelope({kind:'learning.recordPrediction',idempotencyKey:'nav-prediction',target:{scope:'LEARNER',learnerId:f.learnerId,attemptId:a.attemptId},payload:{prediction:{kind:'activity.statement.v1',activityId:'math6',statement:draft.prediction},uncertain:false},expectedAttemptVersion:saved.attemptVersion}));assert.equal(prediction.status,'APPLIED');
  const before=await f.question(a.attemptId);f.h.clock.advance(1000);
  const b=await f.choose(B.releaseId,a.attemptId);assert.ok(b);assert.equal(b.releaseId,B.releaseId);assert.equal((await f.view(a.attemptId)).attemptStatus,'PAUSED');
  f.h.clock.advance(1000);const c=await f.choose(C.releaseId,b.attemptId);assert.ok(c);assert.equal(c.releaseId,C.releaseId);
  assert.equal((await f.view(a.attemptId)).attemptStatus,'PAUSED');assert.equal((await f.view(b.attemptId)).attemptStatus,'PAUSED');
  f.h.clock.advance(1000);assert.deepEqual(await f.choose(A.releaseId,c.attemptId),a);
  assert.equal((await f.view(a.attemptId)).currentCycle?.phase,'OPERATE');assert.deepEqual((await f.question(a.attemptId)).scene.state,before.scene.state);
  const point=await f.h.server.query(f.ctx,{kind:'learning.resumePoint',learnerId:f.learnerId});assert.ok(point.kind==='learning.resumePoint');assert.equal(point.attempt?.attemptId,a.attemptId);
  const rows=f.h.storage.rawDatabase().prepare('SELECT attemptStatus,endedAt FROM learningAttempt').all() as Array<{attemptStatus:string;endedAt:number|null}>;
  assert.equal(rows.filter(r=>r.attemptStatus==='ACTIVE').length,1);assert.equal(rows.filter(r=>r.attemptStatus==='PAUSED').length,2);assert.ok(rows.every(r=>r.endedAt===null));
  assert.ok(!f.requests.some(e=>e.kind==='learning.finishAttempt'||e.kind==='learning.endWithoutCompleting'));
 }finally{await f.h.closeAll();}
});

test('navigation guards direct duplicate paused starts and concurrent start/resume to at most one active per learner',async()=>{
 const f=await setup();try{
  const target={scope:'LEARNER' as const,learnerId:f.learnerId};
  const envelopes=[A,B].map((a,i)=>f.h.envelope({kind:'learning.startAttempt',idempotencyKey:'race-start-'+i,target,payload:{releaseId:a.releaseId}}));
  const receipts=await Promise.all(envelopes.map(e=>f.h.server.handleCommand(f.ctx,e)));assert.deepEqual(receipts.map(r=>r.status),['APPLIED','REJECTED']);
  const aId=receipts[0].effectRefs.find(r=>r.startsWith('attempt:'))!.slice(8);assert.deepEqual(await f.h.server.handleCommand(f.ctx,envelopes[0]),receipts[0]);
  const pause=async(id:string,key:string)=>{const v=await f.view(id);const r=await f.h.server.handleCommand(f.ctx,f.h.envelope({kind:'learning.pauseAttempt',idempotencyKey:key,target:{...target,attemptId:id},payload:{},expectedAttemptVersion:v.version}));assert.equal(r.status,'APPLIED');};
  await pause(aId,'pause-first');
  const duplicate=await f.h.server.handleCommand(f.ctx,f.h.envelope({kind:'learning.startAttempt',idempotencyKey:'duplicate-paused',target,payload:{releaseId:A.releaseId}}));assert.equal(duplicate.status,'REJECTED');
  const b=await f.choose(B.releaseId,null);assert.ok(b);await pause(b.attemptId,'pause-second');
  const versions=await Promise.all([f.view(aId),f.view(b.attemptId)]);
  const resumed=await Promise.all(versions.map((v,i)=>f.h.server.handleCommand(f.ctx,f.h.envelope({kind:'learning.resumeAttempt',idempotencyKey:'race-resume-'+i,target:{...target,attemptId:v.attemptId},payload:{},expectedAttemptVersion:v.version}))));assert.deepEqual(resumed.map(r=>r.status),['APPLIED','REJECTED']);
  assert.equal((f.h.storage.rawDatabase().prepare("SELECT COUNT(*) n FROM learningAttempt WHERE attemptStatus='ACTIVE'").get() as {n:number}).n,1);
  const denied=await f.h.server.handleCommand(f.ctx,f.h.envelope({kind:'learning.resumeAttempt',idempotencyKey:'foreign-learner-resume',target:{scope:'LEARNER',learnerId:'another-learner',attemptId:b.attemptId},payload:{},expectedAttemptVersion:(await f.view(b.attemptId)).version}));assert.equal(denied.errorCode,'FORBIDDEN');
 }finally{await f.h.closeAll();}
});

test('navigation resume point prefers active, otherwise the most recently paused original record',async()=>{
 const f=await setup();try{
  const a=await f.choose(A.releaseId,null);assert.ok(a);f.h.clock.advance(1000);const b=await f.choose(B.releaseId,a.attemptId);assert.ok(b);f.h.clock.advance(1000);await f.choose(A.releaseId,b.attemptId);f.h.clock.advance(1000);
  const v=await f.view(a.attemptId);await f.commands.send('learning.pauseAttempt',{},{scope:'LEARNER',learnerId:f.learnerId,attemptId:a.attemptId},v.version);
  const p=await f.h.server.query(f.ctx,{kind:'learning.resumePoint',learnerId:f.learnerId});assert.ok(p.kind==='learning.resumePoint');assert.equal(p.attempt?.attemptId,a.attemptId);
  assert.deepEqual(await f.choose(A.releaseId,null),a);assert.equal((await f.view(a.attemptId)).attemptStatus,'ACTIVE');
 }finally{await f.h.closeAll();}
});

test('navigation re-practice creates a new attempt only after terminal work and preserves its original history',async()=>{
 const f=await setup();try{
  const a=await f.choose(A.releaseId,null);assert.ok(a);const v=await f.view(a.attemptId);
  // This is an explicit terminal action in the fixture, never an implicit course-switch command.
  const ended=await f.h.server.handleCommand(f.ctx,f.h.envelope({kind:'learning.endWithoutCompleting',idempotencyKey:'explicit-terminal',target:{scope:'LEARNER',learnerId:f.learnerId,attemptId:a.attemptId},payload:{confirmAbandon:true},expectedAttemptVersion:v.version}));assert.equal(ended.status,'APPLIED');
  const old=f.h.storage.rawDatabase().prepare('SELECT * FROM learningAttempt WHERE attemptId=?').get(a.attemptId);
  const next=await f.choose(A.releaseId,null);assert.ok(next);assert.notEqual(next.attemptId,a.attemptId);assert.equal(next.releaseId,A.releaseId);
  assert.deepEqual(f.h.storage.rawDatabase().prepare('SELECT * FROM learningAttempt WHERE attemptId=?').get(a.attemptId),old);
  assert.equal((f.h.storage.rawDatabase().prepare('SELECT previousAttemptId FROM learningAttempt WHERE attemptId=?').get(next.attemptId) as {previousAttemptId:string}).previousAttemptId,a.attemptId);
 }finally{await f.h.closeAll();}
});

test('navigation never pauses an unseen new active course and never starts selected course after an unconfirmed pause',async()=>{
 const f=await setup();try{
  const a=await f.choose(A.releaseId,null);assert.ok(a);const before=f.requests.length;
  await assert.rejects(f.choose(B.releaseId,null),/正在进行的课程已有变化/);assert.equal(f.requests.length,before);
  const calls:CommandKind[]=[];const opened=await enterSelectedCourse({client:f.client,learnerId:f.learnerId,releaseId:B.releaseId,reviewedActiveId:a.attemptId,send:async kind=>{calls.push(kind);return null;}});
  assert.equal(opened,null);assert.deepEqual(calls,['learning.pauseAttempt']);assert.equal((await f.view(a.attemptId)).attemptStatus,'ACTIVE');
  assert.equal((f.h.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM learningAttempt').get() as {n:number}).n,1);
 }finally{await f.h.closeAll();}
});

test('navigation lost pause reply retains original pending key; retry applies once and next click opens selected course',async()=>{
 const f=await setup();try{
  const a=await f.choose(A.releaseId,null);assert.ok(a);f.lose('learning.pauseAttempt');
  assert.equal(await f.choose(B.releaseId,a.attemptId),null);assert.equal((await f.view(a.attemptId)).attemptStatus,'PAUSED');
  const pending=f.commands.getSnapshot().pending;assert.ok(pending);assert.equal(pending.kind,'learning.pauseAttempt');
  assert.equal((f.h.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM learningAttempt').get() as {n:number}).n,1);
  const recovered=await f.commands.retry();assert.equal(recovered?.status,'APPLIED');assert.equal(f.requests.at(-1)?.idempotencyKey,pending.idempotencyKey);
  const b=await f.choose(B.releaseId,null);assert.ok(b);assert.equal(b.releaseId,B.releaseId);
  assert.equal((f.h.storage.rawDatabase().prepare("SELECT COUNT(*) n FROM learningEvent WHERE attemptId=? AND eventType='ATTEMPT_PAUSED'").get(a.attemptId) as {n:number}).n,1);
 }finally{await f.h.closeAll();}
});

test('navigation catalogue remount restores selected lesson title and chapter/topic without changing player source',()=>{
 const math=MATH_LESSONS.find(q=>q.top===10)!,gesp=GESP_LESSONS.find(q=>q.topic!=='B'&&q.session!=='202303')!;
 const defaults={aiUnit:0,mathLessonId:MATH_LESSONS[0].id,gespQuestionId:GESP_LESSONS[0].id},choice={aiUnit:7,mathLessonId:math.id,gespQuestionId:gesp.id};
 assert.deepEqual(restoreCatalogueSelection(JSON.stringify(choice),defaults),choice);
 const m=renderToStaticMarkup(<MathCatalogue selectedId={math.id} onSelect={()=>{}} completed={new Set()}/>);assert.ok(m.includes(math.title));assert.ok(m.includes('aria-pressed="true"'));assert.ok(m.includes('value="10" selected=""'));
 const g=renderToStaticMarkup(<GespCatalogue selectedId={gesp.id} onSelect={()=>{}} completed={new Set()}/>);assert.ok(g.includes(gesp.title));assert.ok(g.includes('aria-pressed="true"'));
 const memory=store(),sessionDescriptor=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),localDescriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');memory.setItem('rondo.mvp.catalogue.family-test.learner-test',JSON.stringify(choice));
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:memory});Object.defineProperty(globalThis,'localStorage',{configurable:true,value:store()});
 try{const html=renderToStaticMarkup(<MvpHome ports={{isMock:false} as AppPorts} learnerId="learner-test" familyId="family-test" subject={0} onSubject={()=>{}} onOpenAttempt={()=>{}} onOpenDaily={()=>{}} onLock={()=>{}} onGuardian={()=>{}}/>);assert.ok(html.includes(math.title));}
 finally{if(sessionDescriptor)Object.defineProperty(globalThis,'sessionStorage',sessionDescriptor);else Reflect.deleteProperty(globalThis,'sessionStorage');if(localDescriptor)Object.defineProperty(globalThis,'localStorage',localDescriptor);else Reflect.deleteProperty(globalThis,'localStorage');}
});
