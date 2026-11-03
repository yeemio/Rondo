/** Bounded daily behavior verification: real auth/domain/SQLite; only synthetic people and fake compiler. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {renderToStaticMarkup} from 'react-dom/server';
import {Harness,GUARDIAN_PASSPHRASE} from '../fixtures/harness';
import {readyDaily,dailyDriver,dailyPolicy,loadDailyReleases,noRunCompiler,correctDailyResponse} from '../fixtures/daily';
import {DAILY_POOL,dailyMathLesson} from '../../modules/curriculum/daily';
import {dailyDate} from '../../modules/learning/daily';
import {parseEnvelope} from '../../modules/contracts/public/envelope';
import type {DailyItemView} from '../../modules/contracts/public/daily';
import type {ActivityState} from '../../modules/contracts/public/activity';
import type {Repositories,TxHandle} from '../../modules/contracts/server/storage';
import {ActivityDrafts,leaveActivityEditor,protectActivityUnload} from '../../apps/web/src/studio/activity-drafts';
import {SessionCommands} from '../../apps/web/src/studio/session-recovery';
import {selectedCourseAttempt,enterSelectedCourse} from '../../apps/web/src/studio/course-navigation';
import {DailyHomeCard,DailySummary} from '../../apps/web/src/studio/DailyHome';
import {DailyModelProgress} from '../../apps/web/src/studio/DailyPlayer';
import {MathQuestions} from '../../apps/web/src/studio/Math6';
import {ActivityHistoryPanel} from '../../apps/web/src/app/Mvp';

const count=(h:Harness,table:string)=>Number(h.storage.rawDatabase().prepare('SELECT count(*) n FROM '+table).get()!.n);
function memory(){const m=new Map<string,string>();return{getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v);},removeItem:(k:string)=>{m.delete(k);}};}
const wrong=(item:DailyItemView)=>[{kind:'mathAnswer' as const,version:'math.answers.v1' as const,lessonId:item.lessonId,answers:[{kind:'quantity' as const,id:item.questionIds[0],value:{kind:'decimal' as const,value:'0.24'},unit:'unitless'}]}];
async function completeCurrentGroup(d:ReturnType<typeof dailyDriver>,setId:string){
  for(;;){const set=(await d.daily(setId)).set!;if(set.status==='COMPLETE')return set;const item=set.items[set.currentIndex];
    if(item.workflow==='daily.model.v1')await d.model(item);await d.answer(item);if(item.workflow==='daily.model.v1')await d.explain(item);await d.advance(setId,set.currentIndex);
  }
}

test('six real math items: wrong → retry → correct, actual circle comparison, gated explanation and honest summary',async()=>{
  const {h,d}=await readyDaily();try{
    let set=await d.start();const id=set.setId;assert.equal(set.items.length,6);assert.equal(DAILY_POOL.length,14);
    const first=set.items[0];assert.equal(first.lessonId,'math6.u1-03');assert.equal((await d.view(first.attemptId!)).currentCycle!.phase,'OPERATE');
    assert.equal((await d.send('learning.revealDaily',{},first.attemptId!,false)).status,'REJECTED');
    assert.equal((await d.send('learning.commitOperation',{operation:{type:'CaptureMathTrial'}},first.attemptId!,false)).status,'REJECTED');
    await d.answer(first,wrong(first));
    let c=(await d.history()).attempts[0].cycles[0];assert.equal(c.prediction,null);assert.equal(c.state.math!.trials.length,0);assert.equal(c.submissions[0].outcome,'REVISE');
    assert.equal((c.submissions[0].feedback as {reveal?:unknown}).reveal,undefined);
    const early=await d.send('learning.advanceDaily',{setId:id,index:0,defer:true},first.attemptId!,false);assert.equal(early.status,'REJECTED');
    await d.send('learning.requestHint',{hintLevel:1},first.attemptId!);await d.send('learning.revealDaily',{},first.attemptId!);
    assert.ok(((await d.history()).attempts[0].cycles[0].submissions[0].feedback as {reveal?:unknown}).reveal);
    await d.send('learning.reviseResponse',{},first.attemptId!);await d.answer(first);await d.advance(id,0);
    for(let i=1;i<5;i++){set=(await d.daily(id)).set!;await d.answer(set.items[i]);await d.advance(id,i);}
    set=(await d.daily(id)).set!;const circle=set.items[5];assert.equal(circle.lessonId,'math6.b16');assert.equal(circle.releaseId,'rondo.mvp.math6-b16-r2');
    await d.send('learning.recordPrediction',{prediction:{kind:'activity.statement.v1',activityId:'math6',statement:'我猜半径3的圆更大，要分别试试半径和直径。'},uncertain:true},circle.attemptId!);
    await d.send('learning.commitOperation',{operation:{type:'CaptureMathTrial'}},circle.attemptId!);
    assert.equal((await d.send('learning.submitResponse',{response:correctDailyResponse(circle)},circle.attemptId!,false)).status,'REJECTED');
    assert.equal((await d.send('learning.advanceDaily',{setId:id,index:5,defer:false},circle.attemptId!,false)).status,'REJECTED');
    for(const radius of [3,1.5]){await d.send('learning.commitOperation',{operation:{type:'SetMathControl',controlId:'radius',value:radius}},circle.attemptId!);await d.send('learning.commitOperation',{operation:{type:'CaptureMathTrial'}},circle.attemptId!);}
    const mixed=correctDailyResponse(circle);assert.equal(mixed[0].kind,'mathAnswer');if(mixed[0].kind==='mathAnswer')mixed[0].answers[1]={kind:'quantity',id:'q2',value:{kind:'decimal',value:'3'},unit:'厘米'};
    await d.answer(circle,mixed);const mixedFeedback=(await d.history()).attempts.find(a=>a.attemptId===circle.attemptId)!.cycles[0].submissions.at(-1)!.feedback as {itemResults:Array<{key:string;verdict:string}>};assert.deepEqual(mixedFeedback.itemResults.filter(x=>['q1','q2'].includes(x.key)).map(x=>x.verdict),['CORRECT','REVISE']);
    assert.equal((await d.send('learning.beginExplanation',{},circle.attemptId!,false)).status,'REJECTED');assert.equal((await d.view(circle.attemptId!)).currentCycle!.phase,'VERIFY');
    await d.send('learning.reviseResponse',{},circle.attemptId!);await d.answer(circle);await d.send('learning.beginExplanation',{},circle.attemptId!);
    assert.equal((await d.send('learning.saveExplanation',{selections:[],freeText:'好了',transcribedByGuardian:false},circle.attemptId!,false)).status,'REJECTED');
    await d.send('learning.saveExplanation',{selections:[],freeText:'第一条圆的半径3、直径6，第二条半径1.5、直径3。直径由两条半径组成，所以两个3厘米不能按同样的开口画。',transcribedByGuardian:false},circle.attemptId!);await d.advance(id,5);
    set=(await d.daily(id)).set!;assert.equal(set.status,'COMPLETE');assert.equal(set.currentIndex,6);
    assert.deepEqual(set.items.map(x=>x.result),['CORRECTED','CORRECT','CORRECT','CORRECT','CORRECT','CORRECTED']);
    assert.equal(set.items[0].hintCount,1);assert.equal(set.items[0].explanationRequested,true);assert.equal(count(h,'learningAttempt'),6);
    assert.equal(count(h,'prediction'),1);assert.equal(count(h,'explanationRevision'),1);assert.equal(count(h,'submission'),8);
    const history=await d.history();c=history.attempts.find(a=>a.attemptId===first.attemptId)!.cycles[0];assert.equal(c.submissions.length,2);assert.equal(c.submissions[0].outcome,'REVISE');
    assert.equal(c.state.math!.trials.length,0);assert.equal(c.prediction,null);assert.deepEqual(c.explanations,[]);
    const actual=history.attempts.find(a=>a.attemptId===circle.attemptId)!.cycles[0];assert.deepEqual(actual.state.math!.trials.slice(-2).map(t=>t.values.radius),[3,1.5]);
    const summaries=h.storage.rawDatabase().prepare('SELECT resultSummaryJson FROM learningAttempt').all();assert.ok(summaries.every(r=>!String(r.resultSummaryJson).includes('"INDEPENDENT"')));
    const html=renderToStaticMarkup(<DailySummary set={set} disabled={false} onHome={()=>{}} onPractice={()=>{}}/>);assert.match(html,/纠正后通过/);assert.match(html,/请求提示/);assert.doesNotMatch(html,/已看过解析|独立完成|已经掌握/);
    const past=renderToStaticMarkup(<ActivityHistoryPanel history={history}/>);assert.match(past,/未计为原课程完整活动完成/);
    assert.equal((await d.start()).setId,id);assert.equal(count(h,'learningAttempt'),6);
    const practice=await d.start('math','practice',id);assert.notEqual(practice.setId,id);assert.equal(practice.items[0].poolId,first.poolId);assert.match(practice.items[0].reason,/纠正/);
    assert.equal((await d.start('gesp','practice',id)).setId,practice.setId);assert.equal(count(h,'learningAttempt'),7);
  }finally{await h.closeAll();}
});

test('concurrent generate/advance and original-key retries create one group, one successor and no duplicate counts',async()=>{
  const {h,d}=await readyDaily();try{
    const a=await d.envelope('learning.startDaily',{scope:'math',mode:'today'},undefined,'same-start');
    const b=await d.envelope('learning.startDaily',{scope:'gesp',mode:'today'},undefined,'different-start');
    const [ra,rb,duplicate]=await Promise.all([d.client.command(a),d.client.command(b),d.client.command(a)]);assert.deepEqual(duplicate,ra);
    assert.equal(ra.effectRefs.find(x=>x.startsWith('daily:')),rb.effectRefs.find(x=>x.startsWith('daily:')));assert.equal(count(h,'learningAttempt'),1);
    const set=(await d.daily()).set!;await d.answer(set.items[0]);
    const next=await d.envelope('learning.advanceDaily',{setId:set.setId,index:0,defer:false},set.items[0].attemptId!,'same-next');
    const nextOther={...next,idempotencyKey:'different-next',commandId:'different-next-command'};
    const [rn,ro,rn2]=await Promise.all([d.client.command(next),d.client.command(nextOther),d.client.command(next)]);assert.equal(ro.status,'APPLIED');assert.deepEqual(rn,rn2);
    assert.equal(count(h,'learningAttempt'),2);assert.equal(count(h,'submission'),1);assert.equal((await d.daily()).set!.currentIndex,1);
    const choice=(await d.daily()).set!.items[1];assert.equal((await d.send('learning.submitResponse',{response:[{kind:'mathAnswer',version:'math.answers.v1',lessonId:choice.lessonId,answers:[{kind:'choice',id:'q3',optionId:''}]}]},choice.attemptId!,false)).status,'REJECTED');assert.equal(count(h,'submission'),1);
    assert.equal(h.storage.rawDatabase().prepare("SELECT count(*) n FROM learningAttempt WHERE attemptStatus='ACTIVE'").get()!.n,1);
    assert.equal(h.storage.rawDatabase().prepare("SELECT count(*) n FROM learningEvent WHERE eventType='DAILY_ITEM_CLOSED'").get()!.n,1);
    await assert.rejects(d.client.command({...next,payload:{setId:set.setId,index:1,defer:false}}),e=>(e as {code:string}).code==='IDEMPOTENCY_CONFLICT');
  }finally{await h.closeAll();}
});

test('failed persistence rolls back group creation and next-item transition before original-key recovery',async()=>{
  const {h,d}=await readyDaily();const realTx=h.storage.tx.bind(h.storage);let fail='DAILY_SET_CREATED';
  h.storage.tx=<T,>(tag:string,fn:(repos:Repositories,tx:TxHandle)=>Promise<T>)=>realTx(tag,(repos,tx)=>{
    const events=Object.create(repos.learningEvent) as Repositories['learningEvent'];events.append=async(scope,event)=>{if(event.eventType===fail)throw Error('synthetic write failure');return repos.learningEvent.append(scope,event);};
    return fn({...repos,learningEvent:events},tx);
  });
  try{
    const create=await d.envelope('learning.startDaily',{scope:'math',mode:'today'});await assert.rejects(d.client.command(create),e=>(e as {code:string}).code==='PERSISTENCE_FAILED');
    assert.equal(count(h,'learningAttempt'),0);assert.equal(count(h,'questionInstance'),0);assert.equal((await d.client.receipt({idempotencyKey:create.idempotencyKey,commandKind:create.kind})).status,'NOT_FOUND');
    fail='';await d.client.command(create);const set=(await d.daily()).set!;await d.answer(set.items[0]);
    const next=await d.envelope('learning.advanceDaily',{setId:set.setId,index:0,defer:false},set.items[0].attemptId!);fail='DAILY_SET_SNAPSHOT';
    await assert.rejects(d.client.command(next),e=>(e as {code:string}).code==='PERSISTENCE_FAILED');assert.equal(count(h,'learningAttempt'),1);assert.equal((await d.view(set.items[0].attemptId!)).attemptStatus,'ACTIVE');assert.equal((await d.daily()).set!.currentIndex,0);
    fail='';assert.equal((await d.client.command(next)).status,'APPLIED');assert.equal(count(h,'learningAttempt'),2);
  }finally{h.storage.tx=realTx;await h.closeAll();}
});

test('pause, saved/read-back draft, close/reopen and yesterday continuation use the original set and attempt',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rondo-daily-reopen-'));const options={dbFile:join(root,'learning.sqlite'),contentRoot:join(root,'content')};
  let {h,learnerId,d}=await readyDaily(options);
  try{
    const set=await d.start(),item=set.items[0],id=item.attemptId!,identity={familyId:h.familyId,learnerId,attemptId:id,releaseId:item.releaseId};
    const store=memory(),editor=new ActivityDrafts(identity,store),v=await d.view(id),q=await d.question(id),basis={...identity,questionInstanceId:q.questionInstanceId,version:v.version};
    editor.readServer(basis,(q.scene.state as ActivityState).draft);editor.edit('answerText',JSON.stringify({q1:'0.24'}));
    const refreshed=new ActivityDrafts(identity,store);refreshed.readServer(basis,(q.scene.state as ActivityState).draft);assert.equal(refreshed.getSnapshot().draft!.answerText,'{"q1":"0.24"}');assert.equal(count(h,'submission'),0);
    let prevented=false;protectActivityUnload({preventDefault(){prevented=true;},returnValue:''} as BeforeUnloadEvent,{dirty:true,locallyStored:false,pending:false,busy:false});assert.equal(prevented,true);
    const leave=await leaveActivityEditor({state:()=>({dirty:refreshed.getSnapshot().dirty,locallyStored:refreshed.getSnapshot().locallyStored,pending:false,busy:false,needsReentry:false,active:true}),notice:refreshed.note,save:async()=>{
      const draft=refreshed.getSnapshot().draft!,r=await d.save(id,draft),after=await d.view(id),read=await d.question(id);refreshed.readServer({...basis,version:after.version},(read.scene.state as ActivityState).draft,draft);return r;
    }});assert.equal(leave,true);assert.equal(refreshed.getSnapshot().dirty,false);await d.send('learning.pauseAttempt',{},id);
    const saved=await d.history(),now=h.clock.now();await h.closeAll();
    h=await Harness.create({...options,policy:dailyPolicy(),compiler:noRunCompiler(),hostEpoch:'daily-reopen-new-host'});h.clock.advance(now+86400000-h.clock.now());await loadDailyReleases(h);
    assert.equal(await h.auth.session(),null);await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});h.familyId=(await h.auth.session())!.familyId;await h.enterLearner(learnerId);d=dailyDriver(h,learnerId);
    assert.deepEqual(await d.history(),saved);const continued=await d.start('gesp');assert.equal(continued.setId,set.setId);assert.equal(continued.date,set.date);assert.equal(continued.items[0].attemptId,id);
    assert.equal((await d.daily()).serverDate,dailyDate(now+86400000));assert.equal(((await d.question(id)).scene.state as ActivityState).draft.answerText,'{"q1":"0.24"}');
    await d.send('learning.resumeAttempt',{},id);await completeCurrentGroup(d,set.setId);
    const nextDay=await d.start();assert.notEqual(nextDay.setId,set.setId);assert.equal(nextDay.date,dailyDate(now+86400000));assert.equal(count(h,'learningAttempt'),7);
    assert.equal((await d.daily(set.setId)).set!.status,'COMPLETE');
  }finally{await h.closeAll();await rm(root,{recursive:true,force:true});}
});

test('lost generation/advance replies retain P0 original-key confirmation and do not repeat learning',async()=>{
  const {h,d,learnerId}=await readyDaily();try{
    const requests:string[]=[],store=memory();let lose=true;
    const client={...d.client,command:async(e:Parameters<typeof d.client.command>[0])=>{requests.push(e.idempotencyKey);const r=await d.client.command(e);if(lose){lose=false;throw Object.assign(Error('synthetic reply lost'),{code:'HOST_RECOVERING',transport:'RECEIPT_UNKNOWN'});}return r;}};
    const commands=new SessionCommands({auth:h.auth,client},{familyId:h.familyId,learnerId},store);
    assert.equal(await commands.send('learning.startDaily',{scope:'math',mode:'today'},{scope:'LEARNER',learnerId}),null);const original=commands.getSnapshot().pending!;assert.ok(original);
    const reopened=new SessionCommands({auth:h.auth,client},{familyId:h.familyId,learnerId},store);assert.equal((await reopened.retry())?.status,'APPLIED');assert.equal(count(h,'learningAttempt'),1);
    const set=(await d.daily()).set!;await d.answer(set.items[0]);const v=await d.view(set.items[0].attemptId!),q=await d.question(v.attemptId);lose=true;
    await reopened.send('learning.advanceDaily',{setId:set.setId,index:0,defer:false},{scope:'LEARNER',learnerId,attemptId:v.attemptId},v.version,{releaseId:v.releaseId,questionInstanceId:q.questionInstanceId,rendererContractVersion:'1'});
    const pending=reopened.getSnapshot().pending!;assert.ok(pending);assert.equal((await reopened.retry())?.status,'APPLIED');assert.equal(count(h,'learningAttempt'),2);assert.equal(count(h,'submission'),1);
    assert.ok(requests.filter(key=>key===original.idempotencyKey).length>=1);assert.equal(reopened.getSnapshot().pending,null);assert.equal((await d.daily()).set!.currentIndex,1);
  }finally{await h.closeAll();}
});

test('GESP short checks have no invented reasoning; two wrong answers can be explicitly left for practice',async()=>{
  const {h,d}=await readyDaily();try{
    let set=await d.start('gesp');assert.ok(set.items.every(i=>i.workflow==='daily.short.v1'));assert.ok(set.items.every(i=>i.lessonId.startsWith('gesp2.202303.')));
    const first=set.items[0];await d.answer(first,[{kind:'singleChoice',selectionId:first.lessonId,optionId:'A'}]);await d.send('learning.reviseResponse',{},first.attemptId!);await d.answer(first,[{kind:'singleChoice',selectionId:first.lessonId,optionId:'C'}]);await d.advance(set.setId,0,true);
    for(let i=1;i<6;i++){set=(await d.daily()).set!;await d.answer(set.items[i]);await d.advance(set.setId,i);}
    set=(await d.daily()).set!;assert.equal(set.status,'COMPLETE');assert.equal(set.items[0].result,'REVIEW');
    const history=await d.history();assert.ok(history.attempts.every(a=>a.cycles[0].prediction===null&&a.cycles[0].explanations.length===0));
    assert.equal(count(h,'prediction'),0);assert.equal(count(h,'explanationRevision'),0);
    assert.ok(history.attempts.every(a=>(a.cycles[0].operations??[]).every(o=>(o.operation as {type:string}).type!=='RecordGespReasoning')));
    const practice=await d.start('gesp','practice',set.setId);assert.equal(practice.items[0].poolId,first.poolId);assert.match(practice.items[0].reason,/待修正/);
    await completeCurrentGroup(d,practice.setId);h.clock.advance(86400000);await d.reenter();const tomorrow=await d.start('gesp');assert.notEqual(tomorrow.setId,practice.setId);assert.notEqual(tomorrow.date,practice.date);assert.equal((await d.daily(set.setId)).set!.items[0].result,'REVIEW');
  }finally{await h.closeAll();}
});

test('server allowlist, family/learner scope, fixed four-hour session, and original course workflow remain bounded',async()=>{
  const a=await readyDaily(),b=await readyDaily();try{
    const set=await a.d.start(),id=set.items[0].attemptId!,ctx=await b.h.learnerContext(b.learnerId);
    await assert.rejects(b.h.server.query(ctx,{kind:'learning.daily',learnerId:a.learnerId}),e=>(e as {code:string}).code==='FORBIDDEN');
    await assert.rejects(b.d.daily(set.setId),e=>(e as {code:string}).code==='FORBIDDEN');
    const denied=await b.h.server.handleCommand(ctx,a.h.envelope({kind:'learning.startDaily',target:{scope:'LEARNER',learnerId:a.learnerId},idempotencyKey:'foreign-generate',payload:{scope:'math',mode:'today'}}));assert.equal(denied.errorCode,'FORBIDDEN');assert.equal(count(b.h,'learningAttempt'),0);
    const schema=await a.d.envelope('learning.startDaily',{scope:'math',mode:'today'});assert.throws(()=>parseEnvelope({...schema,payload:{...schema.payload as object,workflow:'daily.short.v1',releaseId:'rondo.mvp.math6-b16-r2',date:'2027-01-01',score:100}}));
    assert.equal(selectedCourseAttempt(await a.d.history(),set.items[0].releaseId),undefined);
    const opened=await enterSelectedCourse({client:a.d.client,learnerId:a.learnerId,releaseId:set.items[0].releaseId,reviewedActiveId:id,send:async(kind,payload,target,version)=>a.d.client.command(parseEnvelope(a.h.envelope({kind,payload,target:target as {scope:'LEARNER';learnerId:string;attemptId?:string},expectedAttemptVersion:version,idempotencyKey:'original-'+kind})))});
    assert.ok(opened);assert.notEqual(opened.attemptId,id);assert.equal((await a.d.view(opened.attemptId)).currentCycle!.phase,'PREDICT');assert.equal((await a.d.view(id)).attemptStatus,'PAUSED');
    assert.equal((await a.d.send('learning.submitResponse',{response:correctDailyResponse(set.items[0])},opened.attemptId,false)).status,'REJECTED');
    const session=await a.h.auth.session();assert.ok(session);assert.equal(session.expiresAtMs-a.h.clock.now(),4*60*60*1000);a.h.clock.advance(3*60*60*1000);await a.d.daily();assert.equal((await a.h.auth.session())!.expiresAtMs,session.expiresAtMs);
    await a.h.auth.lock();assert.equal(await a.h.auth.session(),null);await assert.rejects(a.d.daily());await a.d.reenter();
    const guardian=await a.h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE}),other=await a.h.createLearner(await a.h.guardianContext(),'另一个合成学生');await a.h.enterLearner(other);
    const otherContext=await a.h.learnerContext(other);await assert.rejects(a.h.server.query(otherContext,{kind:'learning.daily',learnerId:a.learnerId}),e=>(e as {code:string}).code==='FORBIDDEN');
    assert.ok(guardian.familyId);assert.equal((await dailyDriver(a.h,other).daily()).set,null);
  }finally{await a.h.closeAll();await b.h.closeAll();}
});

test('public daily UI shows exact scope, adjacent field feedback and persistent continue before the catalogue',async()=>{
  const {h,d}=await readyDaily();try{
    const set=await d.start(),value=await d.daily(),html=renderToStaticMarkup(<DailyHomeCard value={value} scope="gesp" disabled={false} activeOther={false} onStart={()=>{}} onOpen={()=>{}} onReload={()=>{}}/>);
    assert.match(html,/继续上次练习/);assert.match(html,/第 1 \/ 6 题/);assert.match(html,/数学练习/);
    const field=renderToStaticMarkup(<MathQuestions lesson={dailyMathLesson(set.items[0])!} answers={{q1:'0.24'}} disabled={false} short feedback={[{key:'q1',verdict:'REVISE',feedback:'把两个因数改写成分数，再核对小数位。'}]} onAnswer={()=>{}}/>);
    assert.match(field,/aria-describedby=/);assert.match(field,/aria-invalid="true"/);assert.match(field,/需要修正/);assert.doesNotMatch(field,/0\.07×0\.05/);
    const model=renderToStaticMarkup(<DailyModelProgress records={2} error="请按题面核对直径线，再保存第二个圆。"/>);
    assert.match(model,/半径3厘米/);assert.match(model,/直径3厘米/);assert.match(model,/记录数量不代表任务已经完成/);assert.match(model,/role="alert"/);assert.doesNotMatch(model,/1\.5|半径6|直径6/);
  }finally{await h.closeAll();}
});

test('existing guardian deletion removes old answers; surviving current attempt carries only group organization and missing results stay missing',async()=>{
  const {h,d,learnerId}=await readyDaily();try{
    const set=await d.start(),first=set.items[0].attemptId!,marker='synthetic-deleted-draft-must-not-survive';
    await d.save(first,{explanation:marker});await d.answer(set.items[0]);await d.advance(set.setId,0);
    const current=(await d.daily()).set!.items[1].attemptId!;
    await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});const guardian=await h.guardianContext();
    const prepared=await h.cmd(guardian,{kind:'guardian.prepareDeletion',target:{scope:'FAMILY'},idempotencyKey:'daily-delete-prepare',payload:{target:'ATTEMPT',targetId:first}});
    assert.equal(prepared.status,'APPLIED');const deletionId=prepared.effectRefs.find(x=>x.startsWith('disposal:'))!.slice(9);
    const preview=await h.server.query(guardian,{kind:'guardian.deletionStatus',deletionId});assert.ok(preview.kind==='guardian.deletionStatus');
    const removed=await h.cmd(guardian,{kind:'guardian.confirmDeletion',target:{scope:'FAMILY'},idempotencyKey:'daily-delete-confirm',payload:{preparedDeletionId:deletionId,scopeListHash:preview.scopeHash}});assert.equal(removed.status,'APPLIED');
    assert.equal(h.storage.rawDatabase().prepare('SELECT count(*) n FROM learningEvent WHERE attemptId=?').get(first)!.n,0);
    assert.equal(JSON.stringify(h.storage.rawDatabase().prepare('SELECT payloadJson FROM learningEvent').all()).includes(marker),false);
    await d.reenter();const continued=(await d.daily(set.setId)).set!;assert.equal(continued.status,'OPEN');assert.equal(continued.items[0].state,'MISSING');assert.equal(continued.items[0].result,'NOT_CHECKED');assert.equal(continued.items[1].attemptId,current);
    await completeCurrentGroup(d,set.setId);const summary=(await d.daily(set.setId)).set!;assert.equal(summary.status,'COMPLETE');assert.equal(summary.items.filter(i=>i.result==='CORRECT').length,5);assert.equal(summary.items[0].submissionCount,0);
    assert.deepEqual(h.storage.rawDatabase().prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await h.closeAll();}
});

test('registered P0 history and paused draft survive the daily upgrade without rewriting old facts',{skip:!process.env.RONDO_DAILY_BASELINE_HARNESS},async()=>{
  const baseline=await import(pathToFileURL(resolve(process.env.RONDO_DAILY_BASELINE_HARNESS!)).href) as typeof import('../fixtures/harness');
  const root=await mkdtemp(join(tmpdir(),'rondo-daily-upgrade-')),options={dbFile:join(root,'learning.sqlite'),contentRoot:join(root,'content'),policy:dailyPolicy(),compiler:noRunCompiler()};
  let h=await baseline.Harness.create(options) as Harness;
  try{
    await loadDailyReleases(h);await h.setupFamily('日常升级·旧P0合成家庭');const learner=await h.createLearner(await h.guardianContext(),'原P0合成学生');await h.enterLearner(learner);let d=dailyDriver(h,learner);
    const circle=DAILY_POOL.find(x=>x.lessonId==='math6.b16')!,start=await d.send('learning.startAttempt',{releaseId:circle.releaseId}),id=start.effectRefs.find(x=>x.startsWith('attempt:'))!.slice(8);
    const item={...circle,attemptId:id};await d.model(item);await d.answer(item);await d.explain(item);await d.send('learning.finishAttempt',{},id);
    const original=await d.send('learning.startAttempt',{releaseId:DAILY_POOL[0].releaseId}),paused=original.effectRefs.find(x=>x.startsWith('attempt:'))!.slice(8);await d.save(paused,{prediction:'原P0草稿，尚未提交。',answerText:'{"q1":"0.24"}'});await d.send('learning.pauseAttempt',{},paused);
    const before=await d.history(),rows=h.storage.rawDatabase().prepare('SELECT * FROM learningAttempt ORDER BY attemptId').all(),schema=h.storage.schemaVersion();await h.closeAll();
    h=await Harness.create({...options,hostEpoch:'daily-upgraded-host'});await loadDailyReleases(h);await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});await h.enterLearner(learner);d=dailyDriver(h,learner);
    assert.equal(h.storage.schemaVersion(),schema);assert.deepEqual(await d.history(),before);assert.deepEqual(h.storage.rawDatabase().prepare('SELECT * FROM learningAttempt ORDER BY attemptId').all(),rows);
    const day=await d.start();assert.notEqual(day.items[0].attemptId,paused);assert.deepEqual((await d.history()).attempts.filter(a=>!a.daily),before.attempts);
    assert.equal((await d.view(paused)).currentCycle!.phase,'PREDICT');assert.equal(((await d.question(paused)).scene.state as ActivityState).draft.prediction,'原P0草稿，尚未提交。');
  }finally{await h.closeAll();await rm(root,{recursive:true,force:true});}
});
