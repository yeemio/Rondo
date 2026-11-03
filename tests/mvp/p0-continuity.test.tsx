/** Task B only: real domain/auth/SQLite, synthetic learner, in-process fake compiler. No containers. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {renderToStaticMarkup} from 'react-dom/server';
import {Harness,GUARDIAN_PASSPHRASE} from '../fixtures/harness';
import {applyReleaseStatusChange} from '../../modules/learning/maintenance';
import {CompilerLifecycle,CompilerAdmissionRejected} from '../../modules/learning/compiler-lifecycle';
import {executeActivityCode,hashText,triangle,type StoredCodeRun} from '../../modules/learning/activity-code';
import type {CompilerService,WorkerRun} from '../../workers/cpp/compiler.mjs';
import type {Repositories,TxHandle} from '../../modules/contracts/server/storage';
import type {PublicCommandEnvelope,CommandKind} from '../../modules/contracts/public/envelope';
import type {CommandReceipt} from '../../modules/contracts/public/receipts';
import type {RondoClient} from '../../modules/contracts/public/client';
import {parsePublicProjection} from '../../modules/contracts/public/queries';
import type {ActivityState} from '../../modules/contracts/public/activity';
import {MVP_ACTIVITIES,AI_ACTIVITIES,COMPILER_CONTRACT} from '../../modules/curriculum/mvp';
import {GESP_ACTIVITIES} from '../../modules/curriculum/gesp';
import {SessionCommands,readCodeAvailability} from '../../apps/web/src/studio/session-recovery';
import {ActivityDrafts,activityDraftKey,leaveActivityEditor,protectActivityUnload} from '../../apps/web/src/studio/activity-drafts';
import {enterSelectedCourse} from '../../apps/web/src/studio/course-navigation';
import {AILabWorkspace} from '../../apps/web/src/studio/AILabs';

const CPP=MVP_ACTIVITIES[1],A7=MVP_ACTIVITIES[2],A4=AI_ACTIVITIES.find(a=>a.id==='ai-a4')!;
const PRIVATE_MARKER='synthetic-private-diagnostic-never-public';
class FakeCompiler implements CompilerService {
 readonly jobs=new Map<string,WorkerRun>();
 available=true;hold=false;unknownAt=-1;submitCount=0;closeCount=0;
 constructor(readonly instanceId='p0-synthetic-worker'){}
 async verify(){}
 capability(){return{available:this.available,instanceId:this.instanceId};}
 submit(p:{requestId:string;source:string;stdin:string}){
  const n=this.submitCount++,unknown=n===this.unknownAt;
  const job:WorkerRun&{phase:'run'}={id:'synthetic-worker-job-'+n,requestId:p.requestId,instanceId:this.instanceId,phase:'run',
   state:unknown?'UNKNOWN':this.hold?'RUNNING':'OK',terminal:unknown||!this.hold,
   sourceHash:hashText(p.source),inputHash:hashText(p.stdin),
   result:unknown?{infrastructureError:PRIVATE_MARKER,execution:{stdout:PRIVATE_MARKER,stderr:PRIVATE_MARKER}}:
    {execution:{stdout:triangle(Number(p.stdin)||1),stderr:''}}};
  this.jobs.set(job.id,job);return job;
 }
 read(id:string){return this.jobs.get(id)??null;}
 async cancel(id:string){const job=this.jobs.get(id);if(job&&!job.terminal){job.state='CANCELLED';job.terminal=true;}return job??null;}
 async close(){this.closeCount++;this.available=false;for(const job of this.jobs.values())await this.cancel(job.id);}
}
function memory(){
 const values=new Map<string,string>();let refuseRemove=false;
 return{values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},
  removeItem:(key:string)=>{if(refuseRemove)throw Error('synthetic storage failure');values.delete(key);},refuseRemoval:(value:boolean)=>{refuseRemove=value;}};
}
async function fixture(options:{worker?:FakeCompiler;root?:string}={}){
 const worker=options.worker??new FakeCompiler();let rotations=0,serial=0;
 const h=await Harness.create({compiler:worker,compilerFactory:async()=>{rotations++;return new FakeCompiler('replacement-'+rotations);},
  ...(options.root?{dbFile:join(options.root,'learning.sqlite'),contentRoot:join(options.root,'content')}:{})});
 for(const a of [CPP,A7,A4]){
  await h.content.loadRelease(resolve('dist/content'),a.releaseId);
  for(const to of ['REVIEWED','AVAILABLE'] as const)await applyReleaseStatusChange(h.storage,()=>h.clock.now(),{releaseId:a.releaseId,to,reason:'p0-synthetic-fixture'});
 }
 await h.setupFamily('p0-synthetic');const learnerId=await h.createLearner(await h.guardianContext(),'P0 synthetic learner');
 const ctx=await h.enterLearner(learnerId),identity={familyId:h.familyId,learnerId},requests:PublicCommandEnvelope[]=[];
 const client:RondoClient={command:async envelope=>{requests.push(envelope);return h.server.handleCommand(ctx,envelope);},
  query:request=>h.server.query(ctx,request),receipt:request=>h.server.lookupReceipt(ctx,request),subscribeInvalidation:()=>()=>{}};
 const view=async(attemptId:string)=>{const v=await client.query({kind:'learning.attemptView',attemptId});assert.ok(v.kind==='learning.attemptView');return v;};
 const question=async(attemptId:string)=>{const q=await client.query({kind:'learning.questionView',attemptId});assert.ok(q.kind==='learning.questionView');return q.spec;};
 async function envelope(attemptId:string,kind:CommandKind,payload:unknown){
  const v=await view(attemptId),q=await question(attemptId);
  return h.envelope({kind,payload,idempotencyKey:'p0-command-'+ ++serial,target:{scope:'LEARNER',learnerId,attemptId},
   expectedAttemptVersion:v.version,binding:{releaseId:v.releaseId,questionInstanceId:q.questionInstanceId,rendererContractVersion:'1'}});
 }
 async function start(a:{id:string;releaseId:string}=CPP){
  const receipt=await client.command(h.envelope({kind:'learning.startAttempt',payload:{releaseId:a.releaseId},idempotencyKey:'p0-start-'+ ++serial,target:{scope:'LEARNER',learnerId}}));
  assert.equal(receipt.status,'APPLIED');const id=receipt.effectRefs.find(x=>x.startsWith('attempt:'))!.slice(8);
  const predict=await client.command(await envelope(id,'learning.recordPrediction',{prediction:{kind:'activity.statement.v1',activityId:a.id,statement:'Synthetic prediction for bounded recovery.'},uncertain:true}));
  assert.equal(predict.status,'APPLIED');return id;
 }
 const runEnvelope=(id:string)=>envelope(id,'code.requestRun',{source:'int main(){} // synthetic',stdin:'3\n',taskId:CPP.taskId,compilerContractId:COMPILER_CONTRACT});
 async function terminal(jobId:string){
  for(let i=0;i<150;i++){
   const q=await client.query({kind:'code.runStatus',jobId});assert.ok(q.kind==='code.runStatus');
   if(q.run?.terminal&&q.availability?.reason!=='BUSY')return q;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('Synthetic run failed to settle');
 }
 const events=()=>h.storage.rawDatabase().prepare("SELECT payloadJson FROM learningEvent WHERE eventType='CODE_RUN_STATUS' ORDER BY seq").all().map(r=>String(r.payloadJson));
 const stored=(jobId:string)=>events().map(text=>JSON.parse(text) as StoredCodeRun).filter(s=>s.run.jobId===jobId).at(-1)!;
 return{h,worker,ctx,identity,learnerId,client,requests,view,question,envelope,start,runEnvelope,terminal,events,stored,rotations:()=>rotations};
}
function jobOf(receipt:CommandReceipt){assert.equal(receipt.status,'APPLIED');return receipt.effectRefs.find(x=>x.startsWith('job:'))!.slice(4);}
function rawRun():StoredCodeRun{return{privatePassed:null,run:{jobId:'synthetic-logical-job',requestId:'synthetic-request',attemptId:'synthetic-attempt',cycleId:'synthetic-cycle',
 questionInstanceId:'synthetic-question',taskId:'synthetic-task',attemptVersion:1,source:'int main(){}',stdin:'3\n',sourceHash:hashText('int main(){}'),inputHash:hashText('3\n'),
 compilerContractId:COMPILER_CONTRACT,imageId:'synthetic-image',instanceId:'synthetic-instance',workerJobId:null,status:'QUEUED',terminal:false,stdout:'',stderr:'',createdAt:1,updatedAt:1}};}

test('P0: capability agrees with reservation guards; UNKNOWN and failed persistence never rotate',async()=>{
 for(const [status,persisted] of [['UNKNOWN',true],['OK',false]] as const){
  const worker=new FakeCompiler();let factories=0;const lifecycle=new CompilerLifecycle(worker,async()=>{factories++;return new FakeCompiler();},2);
  assert.equal(lifecycle.capability().available,true);await lifecycle.reserve('first',2);
  assert.equal(lifecycle.capability().reason,'BUSY');assert.equal(lifecycle.capability().available,false);
  await assert.rejects(lifecycle.reserve('busy',1),e=>e instanceof CompilerAdmissionRejected&&e.code==='HOST_RECOVERING');
  lifecycle.settle('first',status,persisted);
  assert.equal(lifecycle.capability().reason,'UNCONFIRMED');assert.equal(lifecycle.isUnresolved('first'),true);
  await assert.rejects(lifecycle.reserve('new',1),e=>e instanceof CompilerAdmissionRejected&&e.code==='HOST_RECOVERING');
  assert.equal(factories,0);assert.equal(worker.submitCount,0);assert.equal(worker.closeCount,0);await lifecycle.close();
 }
 const worker=new FakeCompiler(),lifecycle=new CompilerLifecycle(worker,undefined,1),lease=await lifecycle.reserve('known',1);
 lease.compiler.submit({requestId:'known-visible',source:'s',stdin:'3'});lifecycle.settle('known','OK',true);
 assert.equal(lifecycle.capability().reason,'CAPACITY');assert.equal(lifecycle.capability().available,false);await lifecycle.close();
 const partial=new CompilerLifecycle(new FakeCompiler(),undefined,2),first=await partial.reserve('partial',1);
 first.compiler.submit({requestId:'partial-visible',source:'s',stdin:'3'});partial.settle('partial','OK',true);
 assert.equal(partial.capability(1).available,true);assert.equal(partial.capability(2).reason,'CAPACITY');
 await assert.rejects(partial.reserve('full-check',2),e=>e instanceof CompilerAdmissionRejected&&e.code==='CAPABILITY_UNAVAILABLE');await partial.close();
});

test('P0: private UNKNOWN retains failure receipt and completed checks; public projections contain no private diagnostics',async()=>{
 const worker=new FakeCompiler();worker.unknownAt=2;const f=await fixture({worker});
 try{
  const id=await f.start(),e=await f.runEnvelope(id),[receipt,duplicate]=await Promise.all([f.client.command(e),f.client.command(e)]);
  assert.deepEqual(receipt,duplicate);const jobId=jobOf(receipt),status=await f.terminal(jobId),stored=f.stored(jobId);
  assert.equal(status.run!.status,'UNKNOWN');assert.equal(status.availability!.available,false);assert.equal(status.availability!.reason,'UNCONFIRMED');
  assert.equal(status.run!.stdout,triangle(3));assert.match(status.run!.stderr,/未判分/);
  assert.deepEqual(stored.privateChecks!.map(c=>c.status),['OK','UNKNOWN']);assert.equal(stored.privatePassed,null);
  assert.deepEqual(stored.diagnostics,[{stage:'PRIVATE_CHECK',operation:'RESULT',category:'WORKER_UNKNOWN',workerJobId:'synthetic-worker-job-2',workerPhase:'run',checkIndex:1}]);
  for(const projection of [status,await f.client.query({kind:'learning.activityHistory',learnerId:f.learnerId}),await f.client.query({kind:'learning.timeline',attemptId:id})]){
   parsePublicProjection(projection);const text=JSON.stringify(projection);
   for(const privateValue of [PRIVATE_MARKER,'privateChecks','diagnostics','PRIVATE_CHECK','synthetic-worker-job-2'])assert.equal(text.includes(privateValue),false);
  }
  assert.equal(JSON.stringify(stored).includes(PRIVATE_MARKER),false);
  const before=f.events();assert.deepEqual(await f.client.command(e),receipt);assert.deepEqual(f.events(),before);assert.equal(worker.submitCount,3);assert.equal(f.rotations(),0);
  const next=await f.runEnvelope(id),version=(await f.view(id)).version;
  const denied=await f.client.command(next);assert.equal(denied.status,'REJECTED');assert.equal(denied.errorCode,'HOST_RECOVERING');assert.deepEqual(denied.effectRefs,[]);
  assert.deepEqual(await f.client.command(next),denied);assert.equal((await f.view(id)).version,version);assert.deepEqual(f.events(),before);
  assert.deepEqual(await f.client.receipt({idempotencyKey:next.idempotencyKey,commandKind:next.kind}),{status:'CONFIRMED',receipt:denied});
  assert.equal(f.h.storage.rawDatabase().prepare('SELECT count(*) n FROM commandReceipt WHERE idempotencyKey=?').get(next.idempotencyKey)!.n,1);
  await assert.rejects(f.client.command({...next,payload:{...next.payload as object,source:'different'}}),e=>(e as {code:string}).code==='IDEMPOTENCY_CONFLICT');
  const commands=new SessionCommands({auth:f.h.auth,client:f.client},f.identity,memory());commands.reportFailure({code:'UNAUTHENTICATED',message:'synthetic re-entry'});
  assert.equal((await commands.reenterAndRetry(GUARDIAN_PASSPHRASE)).reentered,true);
  assert.equal((await f.terminal(jobId)).availability!.reason,'UNCONFIRMED');assert.equal(f.rotations(),0);
  assert.equal(worker.submitCount,3);
 }finally{await f.h.closeAll();}
});

test('P0: legacy no-receipt run request terminates under its original key; leave saves the newer draft and another course works',async()=>{
 const worker=new FakeCompiler();worker.unknownAt=1;const f=await fixture({worker});
 try{
  const id=await f.start(),oldRun=await f.client.command(await f.runEnvelope(id)),jobId=jobOf(oldRun);await f.terminal(jobId);
  const legacy=await f.runEnvelope(id),store=memory(),key='rondo.mvp.pending.'+f.learnerId;
  assert.deepEqual(await f.client.receipt({idempotencyKey:legacy.idempotencyKey,commandKind:legacy.kind}),{status:'NOT_FOUND'});
  // The r2 plain-envelope format represents the observed old pre-reserve request, with no receipt row.
  store.setItem(key,JSON.stringify(legacy));
  const commands=new SessionCommands({auth:f.h.auth,client:f.client},f.identity,store),q=await f.question(id),v=await f.view(id);
  const editor=new ActivityDrafts({...f.identity,attemptId:id,releaseId:CPP.releaseId},store);
  const basis={...f.identity,attemptId:id,releaseId:CPP.releaseId,questionInstanceId:q.questionInstanceId,version:v.version};
  editor.readServer(basis,(q.scene.state as ActivityState).draft);editor.edit('source','new unsent source after unknown');editor.edit('stdin','2100 2 28 23 1');
  editor.edit('explanation','Keep this unsubmitted explanation.');const local={...editor.getSnapshot().draft!};
  const state=()=>({dirty:editor.getSnapshot().dirty,locallyStored:editor.getSnapshot().locallyStored,pending:!!commands.getSnapshot().pending,
   pendingRun:commands.getSnapshot().pending?.kind==='code.requestRun',busy:commands.getSnapshot().busy,needsReentry:commands.getSnapshot().needsReentry,active:true});
  let saves=0;
  const left=await leaveActivityEditor({state,notice:editor.note,confirmPendingRun:async()=>{await commands.retry();},save:async()=>{
   saves++;const current=await f.view(id),receipt=await commands.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:local}},
    {scope:'LEARNER',learnerId:f.learnerId,attemptId:id},current.version,legacy.binding);
   const server=(await f.question(id)).scene.state as ActivityState;
   editor.readServer({...basis,version:(await f.view(id)).version},server.draft,local);return receipt;
  }});
  assert.equal(left,true);assert.equal(saves,1);assert.equal(commands.getSnapshot().pending,null);assert.equal(store.getItem(key),null);
  assert.equal(store.getItem(activityDraftKey(f.learnerId)),null);assert.deepEqual((await f.question(id)).scene.state&&((await f.question(id)).scene.state as ActivityState).draft,local);
  assert.equal(f.requests.filter(e=>e.idempotencyKey===legacy.idempotencyKey).length,1);
  assert.deepEqual(f.requests.filter(e=>e.idempotencyKey===legacy.idempotencyKey)[0],legacy);
  const second=await enterSelectedCourse({client:f.client,send:commands.send,learnerId:f.learnerId,releaseId:A7.releaseId,reviewedActiveId:id});assert.ok(second);
  assert.equal((await f.view(id)).attemptStatus,'PAUSED');
  const response=await commands.send('learning.recordPrediction',{prediction:{kind:'activity.statement.v1',activityId:A7.id,statement:'A different synthetic learning activity.'},uncertain:false},
   {scope:'LEARNER',learnerId:f.learnerId,attemptId:second.attemptId},(await f.view(second.attemptId)).version);assert.equal(response?.status,'APPLIED');
  const returned=await enterSelectedCourse({client:f.client,send:commands.send,learnerId:f.learnerId,releaseId:CPP.releaseId,reviewedActiveId:second.attemptId});assert.equal(returned?.attemptId,id);
  assert.deepEqual(((await f.question(id)).scene.state as ActivityState).draft,local);assert.equal((await f.terminal(jobId)).run!.status,'UNKNOWN');
  assert.equal(worker.submitCount,2);assert.equal(f.rotations(),0);
 }finally{await f.h.closeAll();}
});

test('P0: lost accepted reply confirms receipt only, never launches a second run or calls UNKNOWN a success',async()=>{
 const worker=new FakeCompiler();worker.unknownAt=1;const f=await fixture({worker});
 try{
  const id=await f.start(),e=await f.runEnvelope(id),store=memory();let first=true,runCommandCalls=0;
  const client={...f.client,command:async(value:PublicCommandEnvelope)=>{runCommandCalls++;const receipt=await f.client.command(value);if(first){first=false;throw Object.assign(Error('synthetic lost reply'),{code:'HOST_RECOVERING',transport:'RECEIPT_UNKNOWN'});}return receipt;}};
  const commands=new SessionCommands({auth:f.h.auth,client},f.identity,store);
  await commands.send(e.kind,e.payload,e.target,e.expectedAttemptVersion,e.binding);const pending=commands.getSnapshot().pending!;assert.ok(pending);
  const lookup=await f.client.receipt({idempotencyKey:pending.idempotencyKey,commandKind:pending.kind});assert.ok(lookup.status==='CONFIRMED');await f.terminal(jobOf(lookup.receipt));
  const receipt=await commands.retry();assert.deepEqual(receipt,lookup.receipt);assert.equal(commands.getSnapshot().pending,null);assert.equal(runCommandCalls,1);assert.equal(worker.submitCount,2);
  assert.match(commands.getSnapshot().recoveryNote,/是否得到结果请看运行状态/);assert.doesNotMatch(commands.getSnapshot().recoveryNote,/运行成功|已完成|保存已确认/);
  await commands.retry();assert.equal(runCommandCalls,1);
 }finally{await f.h.closeAll();}
});

test('P0: only definite matching rejection clears pending; unreadable transport, ADMITTED, mismatch and local cleanup failure remain protected',async()=>{
 const f=await fixture();try{
  const id=await f.start(),e=await f.runEnvelope(id);
  for(const mode of ['transport','admitted','mismatch','cleanup'] as const){
   const store=memory();store.setItem('rondo.mvp.pending.'+f.learnerId,JSON.stringify({...f.identity,envelope:e}));
   const receipt:CommandReceipt={protocolVersion:'rondo.v1',commandId:e.commandId,idempotencyKey:e.idempotencyKey,kind:e.kind,status:'REJECTED',errorCode:'HOST_RECOVERING',effectRefs:[],changedKinds:[]};
   if(mode==='cleanup')store.refuseRemoval(true);
   const client={command:async()=>{
    if(mode==='transport')throw Object.assign(Error('still unknown'),{code:'HOST_RECOVERING'});
    if(mode==='admitted')return{...receipt,status:'ADMITTED' as const,errorCode:undefined};
    if(mode==='mismatch')return{...receipt,commandId:'another-command'};
    return receipt;
   }};
   const commands=new SessionCommands({auth:f.h.auth,client},f.identity,store);await commands.retry();assert.deepEqual(commands.getSnapshot().pending,e);
   assert.equal(protectActivityUnload({preventDefault(){},returnValue:''},{dirty:false,locallyStored:true,pending:true,busy:false}),true);
   if(mode==='cleanup'){store.refuseRemoval(false);await commands.retry();assert.equal(commands.getSnapshot().pending,null);assert.match(commands.getSnapshot().recoveryNote,/未执行/);}
  }
  assert.equal(f.worker.submitCount,0);
 }finally{await f.h.closeAll();}
});

test('P0: stale original code request has a durable rejection, not a new execution or an unending pending item',async()=>{
 const f=await fixture();try{
  const id=await f.start(),e=await f.runEnvelope(id),draft=((await f.question(id)).scene.state as ActivityState).draft;
  await f.client.command(await f.envelope(id,'learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:{...draft,source:'a newer draft'}}}));
  const receipt=await f.client.command(e);assert.equal(receipt.status,'REJECTED');assert.equal(receipt.errorCode,'VERSION_CONFLICT');
  assert.deepEqual(await f.client.command(e),receipt);assert.equal(f.worker.submitCount,0);
 }finally{await f.h.closeAll();}
});

test('P0: admission persistence failure rolls back and retains pending, never fabricates a definitive rejection',async()=>{
 const f=await fixture();try{
  const id=await f.start(),e=await f.runEnvelope(id),realTx=f.h.storage.tx.bind(f.h.storage);let fail=true;
  f.h.storage.tx=async<T,>(name:string,fn:(repos:Repositories,tx:TxHandle)=>Promise<T>):Promise<T>=>realTx(name,async(repos,tx)=>{
   const value=await fn(repos,tx);if(fail&&name==='cmd.code.requestRun')throw Object.assign(Error('synthetic transaction rollback'),{code:'PERSISTENCE_FAILED'});return value;
  });
  const commands=new SessionCommands({auth:f.h.auth,client:f.client},f.identity,memory());
  await commands.send(e.kind,e.payload,e.target,e.expectedAttemptVersion,e.binding);const original=commands.getSnapshot().pending!;assert.ok(original);
  assert.equal(f.worker.submitCount,0);assert.deepEqual(await f.client.receipt({idempotencyKey:original.idempotencyKey,commandKind:original.kind}),{status:'NOT_FOUND'});
  assert.equal((await f.view(id)).version,e.expectedAttemptVersion);assert.equal(f.events().length,0);
  fail=false;const receipt=await commands.retry();assert.ok(receipt);await f.terminal(jobOf(receipt));assert.equal(f.worker.submitCount,4);
  assert.deepEqual(f.requests.filter(r=>r.kind==='code.requestRun')[0],f.requests.filter(r=>r.kind==='code.requestRun')[1]);
 }finally{await f.h.closeAll();}
});

test('P0: result persistence failure remains UNKNOWN and blocks new runs even when the durable event is nonterminal',async()=>{
 const f=await fixture();const logs:string[]=[],originalLog=console.error;console.error=(value:unknown)=>{logs.push(String(value));};
 try{
  const id=await f.start(),e=await f.runEnvelope(id),realTx=f.h.storage.tx.bind(f.h.storage);
  f.h.storage.tx=async<T,>(name:string,fn:(repos:Repositories,tx:TxHandle)=>Promise<T>):Promise<T>=>{
   if(name==='code.status')throw Error(PRIVATE_MARKER);return realTx(name,fn);
  };
  const receipt=await f.client.command(e),jobId=jobOf(receipt),status=await f.terminal(jobId);
  assert.equal(f.stored(jobId).run.terminal,false);assert.equal(status.run!.status,'UNKNOWN');assert.equal(status.availability!.reason,'UNCONFIRMED');
  assert.ok(logs.some(line=>line.includes('PERSISTENCE_FAILED')&&line.includes(jobId)));assert.ok(logs.every(line=>!line.includes(PRIVATE_MARKER)&&!line.includes(e.payload.source as string)));
  assert.deepEqual(await f.client.command(e),receipt);const denied=await f.client.command(await f.runEnvelope(id));assert.equal(denied.status,'REJECTED');
  assert.equal(f.worker.submitCount,1);assert.equal(f.rotations(),0);
 }finally{console.error=originalLog;await f.h.closeAll();}
});

test('P0: missing worker result and cancellation-racing UNKNOWN stay unknown; logs never include raw failure contents',async()=>{
 const logs:string[]=[],originalLog=console.error;console.error=(value:unknown)=>{logs.push(String(value));};
 try{
  const worker=new FakeCompiler();worker.hold=true;const s=rawRun();
  await executeActivityCode({submit:p=>worker.submit(p),read:()=>null,cancel:id=>worker.cancel(id)},s,[],async()=>{},()=>false);
  assert.equal(s.run.status,'UNKNOWN');assert.equal(s.diagnostics![0].category,'MISSING_JOB');assert.equal(s.diagnostics![0].operation,'READ');
  const unknown=new FakeCompiler();unknown.unknownAt=0;const cancelled=rawRun();let requested=false;
  await executeActivityCode({submit:p=>{const job=unknown.submit(p);requested=true;return job;},read:id=>unknown.read(id),cancel:id=>unknown.cancel(id)},cancelled,[],async()=>{},()=>requested);
  assert.equal(cancelled.run.status,'UNKNOWN');assert.equal(cancelled.privatePassed,null);
  assert.ok(logs.every(line=>!line.includes(PRIVATE_MARKER)));assert.doesNotMatch(cancelled.run.stderr,/重新运行/);
 }finally{console.error=originalLog;}
});

test('P0: old payloads, original attempts and UNKNOWN receipts survive SQLite close/reopen without replay or rewriting old facts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rondo-p0-compat-')),worker=new FakeCompiler();worker.unknownAt=1;
 const f=await fixture({root,worker});let reopened:Harness|undefined;
 try{
  const id=await f.start(),e=await f.runEnvelope(id),receipt=await f.client.command(e),jobId=jobOf(receipt);await f.terminal(jobId);
  // The first QUEUED event deliberately has the old shape (no diagnostics field).
  assert.equal('diagnostics' in JSON.parse(f.events()[0]),false);
  const legacy=f.stored(jobId);delete legacy.diagnostics;legacy.run.stderr=PRIVATE_MARKER;
  await f.h.storage.tx('synthetic.legacy-payload',repos=>repos.learningEvent.append({familyId:f.identity.familyId,actorId:f.ctx.actorId},
   {attemptId:id,familyId:f.identity.familyId,commandKind:'code.requestRun',eventType:'CODE_RUN_STATUS',payloadJson:JSON.stringify(legacy),payloadVersion:'1',occurredAt:f.h.clock.now()}));
  const oldEvents=f.events();assert.match(oldEvents.at(-1)!,new RegExp(PRIVATE_MARKER));
  const saved=(await f.question(id)).scene.state,version=(await f.view(id)).version;
  await f.h.closeAll();const nextWorker=new FakeCompiler('explicit-reopened-synthetic-host');
  reopened=await Harness.create({dbFile:join(root,'learning.sqlite'),contentRoot:join(root,'content'),compiler:nextWorker});
  await reopened.content.loadRelease(resolve('dist/content'),CPP.releaseId);
  const guardian=await reopened.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});reopened.familyId=guardian.familyId;
  const ctx=await reopened.enterLearner(f.learnerId);
  assert.deepEqual(await reopened.server.handleCommand(ctx,e),receipt);assert.equal(nextWorker.submitCount,0);
  const status=await reopened.server.query(ctx,{kind:'code.runStatus',jobId});assert.ok(status.kind==='code.runStatus');assert.equal(status.run!.status,'UNKNOWN');
  assert.equal(JSON.stringify(status).includes(PRIVATE_MARKER),false);
  const q=await reopened.server.query(ctx,{kind:'learning.questionView',attemptId:id});assert.ok(q.kind==='learning.questionView');assert.deepEqual(q.spec.scene.state,saved);
  const v=await reopened.server.query(ctx,{kind:'learning.attemptView',attemptId:id});assert.ok(v.kind==='learning.attemptView');assert.equal(v.version,version);
  assert.deepEqual(reopened.storage.rawDatabase().prepare("SELECT payloadJson FROM learningEvent WHERE eventType='CODE_RUN_STATUS' ORDER BY seq").all().map(r=>String(r.payloadJson)),oldEvents);
 }finally{await reopened?.closeAll();await f.h.closeAll();await rm(root,{recursive:true,force:true});}
});

test('P0 A4: latest confirmed classification and its frozen parameter are beside the action; history remains folded',async()=>{
 const f=await fixture();try{
  const id=await f.start(A4),operate=async(operation:object)=>{const receipt=await f.client.command(await f.envelope(id,'learning.commitOperation',{operation}));assert.equal(receipt.status,'APPLIED');};
  const lab=async()=>{const value=((await f.question(id)).scene.state as ActivityState).lab;assert.ok(value?.kind==='a4');return value;};
  const render=async()=>renderToStaticMarkup(<AILabWorkspace lab={await lab()} disabled={false} onOperation={()=>{}} answers={{}}/>);
  assert.match(await render(),/还没有已确认的使用结果/);
  await operate({type:'AdjustAIParameter',value:2});await operate({type:'FreezeAIModel'});await operate({type:'TestAIFrozenModel',width:3,height:7});
  let html=await render();let main=html.split('<details class="lab-trials">')[0];
  assert.match(main,/最近一次已确认分类：细长/);assert.match(main,/所用冻结参数为2/);assert.match(main,/这次使用没有改变参数/);
  assert.ok(main.indexOf('使用冻结模型')<main.indexOf('最近一次已确认分类'));assert.match(main,/没有调用在线模型或进行真实模型训练/);
  await operate({type:'TestAIFrozenModel',width:4,height:7});html=await render();main=html.split('<details class="lab-trials">')[0];
  assert.match(main,/最近一次已确认分类：舒展/);assert.match(main,/第2次使用：新卡宽4、高7/);assert.match(main,/输入已改动/);
  assert.match(html,/<details class="lab-trials"><summary>参数调整与使用记录/);assert.match(html,/使用记录1/);assert.match(html,/使用记录2/);
  const state=await lab();assert.equal(state.weight,2);assert.equal(state.frozenWeight,2);assert.equal(state.trials.length,2);
  await operate({type:'RestartAITraining'});await operate({type:'AdjustAIParameter',value:3});
  main=(await render()).split('<details class="lab-trials">')[0];assert.match(main,/所用冻结参数为2/);assert.match(main,/之前那次已确认结果/);
 }finally{await f.h.closeAll();}
});


// R2 is a separate focused check group. The original P0 evidence remains in the R1 logs.
async function nextProgrammingTask(f:Awaited<ReturnType<typeof fixture>>,currentId:string){
 const activity=GESP_ACTIVITIES.find(a=>a.id==='gesp-program')!;
 await f.h.content.loadRelease(resolve('dist/content'),activity.releaseId);
 for(const to of ['REVIEWED','AVAILABLE'] as const)await applyReleaseStatusChange(f.h.storage,()=>f.h.clock.now(),{releaseId:activity.releaseId,to,reason:'p0-r2-synthetic-fixture'});
 assert.equal((await f.client.command(await f.envelope(currentId,'learning.pauseAttempt',{}))).status,'APPLIED');
 return {activity,id:await f.start(activity)};
}
async function currentCodeAvailability(f:Awaited<ReturnType<typeof fixture>>,attemptId:string){
 // The same read helper used by MvpPlayer.load and its explicit environment refresh.
 return readCodeAvailability(f.client,attemptId,(await f.question(attemptId)).questionInstanceId);
}

test('P0 R2: a new programming task reads the Host UNKNOWN lock before any run and after definitive rejection',async()=>{
 const worker=new FakeCompiler();worker.unknownAt=1;const f=await fixture({worker});
 try{
  const first=await f.start(),original=await f.runEnvelope(first),receipt=await f.client.command(original),jobId=jobOf(receipt);
  await f.terminal(jobId);const next=await nextProgrammingTask(f,first),oldEvents=f.events(),submitted=worker.submitCount;
  const history=await f.client.query({kind:'learning.activityHistory',learnerId:f.learnerId});assert.ok(history.kind==='learning.activityHistory');
  assert.deepEqual(history.attempts.find(a=>a.attemptId===next.id)!.cycles.flatMap(c=>c.runs),[]);
  assert.deepEqual(await currentCodeAvailability(f,next.id),{available:false,reason:'UNCONFIRMED'});
  const projection=await f.client.query({kind:'code.availability',attemptId:next.id});parsePublicProjection(projection);
  assert.deepEqual(Object.keys(projection).sort(),['attemptId','availability','kind','questionInstanceId']);
  for(const secret of [PRIVATE_MARKER,'privateInputs','codeCases','privateChecks','diagnostics','workerJobId','instanceId','capacity'])assert.equal(JSON.stringify(projection).includes(secret),false);
  const request=await f.envelope(next.id,'code.requestRun',{source:'int main(){} // next synthetic task',stdin:'3\n',taskId:next.activity.taskId,compilerContractId:COMPILER_CONTRACT});
  const commands=new SessionCommands({auth:f.h.auth,client:f.client},f.identity,memory());
  assert.equal(await commands.send(request.kind,request.payload,request.target,request.expectedAttemptVersion,request.binding),null);
  assert.equal(commands.getSnapshot().errorCode,'HOST_RECOVERING');assert.equal(commands.getSnapshot().pending,null);
  const originalDenied=f.requests.at(-1)!,lookup=await f.client.receipt({idempotencyKey:originalDenied.idempotencyKey,commandKind:originalDenied.kind});
  assert.ok(lookup.status==='CONFIRMED');const rejected=lookup.receipt;assert.equal(rejected.status,'REJECTED');assert.equal(rejected.errorCode,'HOST_RECOVERING');
  // A reload after rejection cannot reset this no-run task to an unknown/optimistic capability.
  assert.deepEqual(await currentCodeAvailability(f,next.id),{available:false,reason:'UNCONFIRMED'});
  assert.deepEqual(await f.client.command(originalDenied),rejected);
  assert.deepEqual(await f.client.receipt({idempotencyKey:originalDenied.idempotencyKey,commandKind:originalDenied.kind}),{status:'CONFIRMED',receipt:rejected});
  for(let i=0;i<2;i++)assert.deepEqual(await currentCodeAvailability(f,next.id),{available:false,reason:'UNCONFIRMED'});
  assert.deepEqual(await f.client.command(original),receipt);assert.equal((await f.terminal(jobId)).run!.status,'UNKNOWN');
  assert.deepEqual(f.events(),oldEvents);assert.equal(worker.submitCount,submitted);assert.equal(f.rotations(),0);assert.equal(worker.closeCount,0);
  await assert.rejects(f.h.server.query({...f.ctx,learnerId:'another-synthetic-learner'},{kind:'code.availability',attemptId:next.id}),e=>(e as {code:string}).code==='FORBIDDEN');
  await assert.rejects(f.h.server.query({...f.ctx,familyId:'another-synthetic-family'},{kind:'code.availability',attemptId:next.id}),e=>(e as {code:string}).code==='FORBIDDEN');
  await assert.rejects(readCodeAvailability(f.client,next.id,'stale-synthetic-question'),/编程题已有变化/);
 }finally{await f.h.closeAll();}
});

test('P0 R2: a no-run task reads BUSY, then explicit read sees READY without submitting or reserving a job',async()=>{
 const worker=new FakeCompiler();worker.hold=true;const f=await fixture({worker});
 try{
  const first=await f.start(),original=await f.client.command(await f.runEnvelope(first)),jobId=jobOf(original),next=await nextProgrammingTask(f,first);
  assert.deepEqual(await currentCodeAvailability(f,next.id),{available:false,reason:'BUSY'});
  assert.equal((await f.client.command(await f.envelope(first,'code.requestCancel',{jobId}))).status,'APPLIED');
  assert.equal((await f.terminal(jobId)).run!.status,'CANCELLED');const submitted=worker.submitCount,before=f.events();
  assert.deepEqual(await currentCodeAvailability(f,next.id),{available:true,reason:'READY'});
  assert.deepEqual(await currentCodeAvailability(f,next.id),{available:true,reason:'READY'});
  assert.equal(worker.submitCount,submitted);assert.deepEqual(f.events(),before);assert.equal(f.rotations(),0);
  // A subsequent deliberate command can reserve; the read itself left no lease behind.
  worker.hold=false;
  const nextReceipt=await f.client.command(await f.envelope(next.id,'code.requestRun',{source:'int main(){} // deliberate next task',stdin:'3\n',taskId:next.activity.taskId,compilerContractId:COMPILER_CONTRACT}));
  await f.terminal(jobOf(nextReceipt));assert.ok(worker.submitCount>submitted);
 }finally{await f.h.closeAll();}
});

test('P0 R2: unavailable worker is visible without run history, survives rejected reload and recovers by explicit read',async()=>{
 const worker=new FakeCompiler();worker.available=false;const f=await fixture({worker});
 try{
  const id=await f.start(),version=(await f.view(id)).version;
  assert.deepEqual(await currentCodeAvailability(f,id),{available:false,reason:'UNAVAILABLE'});
  const request=await f.runEnvelope(id),denied=await f.client.command(request);assert.equal(denied.status,'REJECTED');assert.equal(denied.errorCode,'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(await currentCodeAvailability(f,id),{available:false,reason:'UNAVAILABLE'});
  assert.deepEqual(await f.client.command(request),denied);assert.equal((await f.view(id)).version,version);assert.deepEqual(f.events(),[]);
  worker.available=true;
  assert.deepEqual(await currentCodeAvailability(f,id),{available:true,reason:'READY'});assert.equal(worker.submitCount,0);assert.equal(f.rotations(),0);
  await f.terminal(jobOf(await f.client.command(await f.runEnvelope(id))));
 }finally{await f.h.closeAll();}
});

test('P0 R2: saved terminal and orphaned runs remain read-only and safe after SQLite reopen with no compiler',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rondo-p0-r2-readonly-')),f=await fixture({root});let reopened:Harness|undefined;
 try{
  const id=await f.start(),knownId=jobOf(await f.client.command(await f.runEnvelope(id))),known=await f.terminal(knownId);
  f.worker.unknownAt=f.worker.submitCount+1;
  const unknownId=jobOf(await f.client.command(await f.runEnvelope(id)));await f.terminal(unknownId);
  // A legacy nonterminal event represents a previously interrupted Host; it must not be rewritten or replayed.
  const orphan=structuredClone(f.stored(unknownId));delete orphan.diagnostics;
  orphan.run={...orphan.run,jobId:'synthetic-legacy-orphan',requestId:'synthetic-legacy-orphan-request',status:'RUNNING',terminal:false,stderr:PRIVATE_MARKER};
  await f.h.storage.tx('synthetic.legacy-orphan',repos=>repos.learningEvent.append({familyId:f.identity.familyId,actorId:f.ctx.actorId},
   {attemptId:id,familyId:f.identity.familyId,commandKind:'code.requestRun',eventType:'CODE_RUN_STATUS',payloadJson:JSON.stringify(orphan),payloadVersion:'1',occurredAt:f.h.clock.now()}));
  const oldEvents=f.events(),version=(await f.view(id)).version;
  await f.h.closeAll();
  reopened=await Harness.create({dbFile:join(root,'learning.sqlite'),contentRoot:join(root,'content')});
  await reopened.content.loadRelease(resolve('dist/content'),CPP.releaseId);
  const guardian=await reopened.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});reopened.familyId=guardian.familyId;
  const ctx=await reopened.enterLearner(f.learnerId);
  for(const jobId of [knownId,unknownId,orphan.run.jobId]){
   const status=await reopened.server.query(ctx,{kind:'code.runStatus',jobId});assert.ok(status.kind==='code.runStatus');parsePublicProjection(status);
   assert.deepEqual(status.availability,{available:false,reason:'UNAVAILABLE'});
   assert.equal(status.run!.terminal,true);assert.equal(status.run!.status,jobId===knownId?known.run!.status:'UNKNOWN');
   assert.equal(status.run!.source,known.run!.source);assert.equal(JSON.stringify(status).includes(PRIVATE_MARKER),false);
  }
  const availability=await reopened.server.query(ctx,{kind:'code.availability',attemptId:id});assert.ok(availability.kind==='code.availability');
  assert.deepEqual(availability.availability,{available:false,reason:'UNAVAILABLE'});
  const view=await reopened.server.query(ctx,{kind:'learning.attemptView',attemptId:id});assert.ok(view.kind==='learning.attemptView');assert.equal(view.version,version);
  assert.deepEqual(reopened.storage.rawDatabase().prepare("SELECT payloadJson FROM learningEvent WHERE eventType='CODE_RUN_STATUS' ORDER BY seq").all().map(r=>String(r.payloadJson)),oldEvents);
 }finally{await reopened?.closeAll();await f.h.closeAll();await rm(root,{recursive:true,force:true});}
});
