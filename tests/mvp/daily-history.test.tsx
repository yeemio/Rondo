/** R2 only: reopen a retained R1 summary through the public history navigation. No real people or compiler. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Children,isValidElement,type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Harness,GUARDIAN_PASSPHRASE,type HarnessOptions} from '../fixtures/harness';
import {dailyDriver,dailyPolicy,loadDailyReleases,noRunCompiler,correctDailyResponse} from '../fixtures/daily';
import {DAILY_POOL} from '../../modules/curriculum/daily';
import {gespLessonForRelease} from '../../modules/curriculum/gesp';
import {evaluateDailyShort} from '../../modules/learning/daily';
import type {ActivityRule} from '../../modules/contracts/server/rules-activity';
import {activityHistorySchema,type ActivityState} from '../../modules/contracts/public/activity';
import type {DailyProjection,DailySetView} from '../../modules/contracts/public/daily';
import {DailyHistoryLinks,DailyHomeCard,DailySummary} from '../../apps/web/src/studio/DailyHome';
import {ActivityHistoryPanel} from '../../apps/web/src/app/Mvp';
import {ActivityDrafts} from '../../apps/web/src/studio/activity-drafts';

const factsTables=['learningAttempt','learningCycle','questionInstance','learningEvent','submission','evaluation','hintPresentation','prediction','explanationRevision'];
const facts=(h:Harness)=>Object.fromEntries(factsTables.map(table=>[table,h.storage.rawDatabase().prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
const forbidden=(e:unknown)=>(e as {code:string}).code==='FORBIDDEN';
function elements(node:ReactNode,predicate:(e:ReactElement<Record<string,unknown>>)=>boolean):Array<ReactElement<Record<string,unknown>>>{
  const result:Array<ReactElement<Record<string,unknown>>>=[];
  Children.forEach(node,child=>{if(isValidElement<Record<string,unknown>>(child)){if(predicate(child))result.push(child);result.push(...elements(child.props.children as ReactNode,predicate));}});
  return result;
}
function button(node:ReactNode,label:RegExp){
  const found=elements(node,e=>e.type==='button'&&label.test(renderToStaticMarkup(e)));
  assert.equal(found.length,1,'one discoverable button for '+label);return found[0];
}
function click(node:ReactElement<Record<string,unknown>>){assert.notEqual(node.props.disabled,true);(node.props.onClick as ()=>void)();}
function historyLinks(history:Parameters<typeof ActivityHistoryPanel>[0]['history'],onOpenDaily:(id:string)=>void,disabled=false){
  const panel=ActivityHistoryPanel({history,onOpenDaily,disabled});
  const links=elements(panel,e=>e.type===DailyHistoryLinks);assert.equal(links.length,1,'history panel forwards its real navigation callback');
  return DailyHistoryLinks(links[0].props as unknown as Parameters<typeof DailyHistoryLinks>[0]);
}
async function fixtureHarness(options:HarnessOptions){
  const baseline=process.env.RONDO_DAILY_R2_BASELINE_HARNESS;
  const original=baseline?await import(pathToFileURL(resolve(baseline)).href) as typeof import('../fixtures/harness'):{Harness};
  return original.Harness.create(options) as Promise<Harness>;
}
async function initialize(h:Harness){
  h.clock.advance(Date.parse('2026-11-02T04:00:00Z')-h.clock.now());await loadDailyReleases(h);
  await h.setupFamily('历史题组·仅合成验证');const learnerId=await h.createLearner(await h.guardianContext(),'合成历史学生');await h.enterLearner(learnerId);
  return {learnerId,d:dailyDriver(h,learnerId)};
}
async function reopen(options:HarnessOptions,now:number,learnerId:string){
  const h=await Harness.create({...options,hostEpoch:'daily-r2-reopen'});h.clock.advance(now-h.clock.now());await loadDailyReleases(h);
  await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});h.familyId=(await h.auth.session())!.familyId;await h.enterLearner(learnerId);return h;
}
async function removeAttempt(h:Harness,d:ReturnType<typeof dailyDriver>,attemptId:string){
  await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});const guardian=await h.guardianContext();
  const prepared=await h.cmd(guardian,{kind:'guardian.prepareDeletion',target:{scope:'FAMILY'},idempotencyKey:'r2-delete-prepare-'+attemptId,payload:{target:'ATTEMPT',targetId:attemptId}});
  assert.equal(prepared.status,'APPLIED');const deletionId=prepared.effectRefs.find(x=>x.startsWith('disposal:'))!.slice(9);
  const preview=await h.server.query(guardian,{kind:'guardian.deletionStatus',deletionId});assert.ok(preview.kind==='guardian.deletionStatus');
  assert.equal((await h.cmd(guardian,{kind:'guardian.confirmDeletion',target:{scope:'FAMILY'},idempotencyKey:'r2-delete-confirm-'+attemptId,payload:{preparedDeletionId:deletionId,scopeListHash:preview.scopeHash}})).status,'APPLIED');
  await d.reenter();
}

test('history navigation reopens the original 5/1/1 summary and preserves the next group',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rondo-daily-history-')),options={dbFile:join(root,'learning.sqlite'),contentRoot:join(root,'content'),policy:dailyPolicy(),compiler:noRunCompiler()};
  let h=await fixtureHarness(options);
  try{
    const initial=await initialize(h),learnerId=initial.learnerId;let d=initial.d;
    // Set up completed facts with the unchanged R1 flow; the test assertions below target R2 navigation only.
    let old=await d.start();const first=old.items[0],id=first.attemptId!;
    await d.answer(first,[{kind:'mathAnswer',version:'math.answers.v1',lessonId:first.lessonId,answers:[{kind:'quantity',id:'q1',value:{kind:'decimal',value:'0.24'},unit:'unitless'}]}]);
    await d.send('learning.requestHint',{hintLevel:1},id);await d.send('learning.reviseResponse',{},id);await d.answer(first);await d.advance(old.setId,0);
    for(let i=1;i<6;i++){old=(await d.daily(old.setId)).set!;const item=old.items[i];if(item.workflow==='daily.model.v1')await d.model(item);await d.answer(item);if(item.workflow==='daily.model.v1')await d.explain(item);await d.advance(old.setId,i);}
    const original=(await d.daily(old.setId)).set!,frozenReason=original.items[0].reason;
    assert.equal(original.items.filter(i=>i.result==='CORRECT').length,5);assert.equal(original.items.filter(i=>i.result==='CORRECTED').length,1);assert.equal(original.items.reduce((n,i)=>n+i.hintCount,0),1);
    h.clock.advance(86400000);await d.reenter();const next=await d.start('math','practice',original.setId),nextId=next.items[0].attemptId!;
    await d.save(nextId,{answerText:'{"q1":"0.04"}'});
    const originalHistory=await d.history(),before=facts(h),now=h.clock.now();await h.closeAll();
    h=await reopen(options,now,learnerId);d=dailyDriver(h,learnerId);
    assert.deepEqual(facts(h),before,'opening R1 storage did not rewrite learning facts');
    t.diagnostic(process.env.RONDO_DAILY_R2_BASELINE_HARNESS?'Fixture written by the exact 508063f baseline Harness, then reopened with R2.':'Fixture written by the current Harness; supply RONDO_DAILY_R2_BASELINE_HARNESS for the baseline compatibility check.');

    await t.test('public history button → old setId query → original summary → home continues original next attempt',async()=>{
      const history=await d.history();assert.deepEqual(history.attempts,originalHistory.attempts);
      assert.equal(history.dailySets!.length,2);assert.equal(history.dailySets!.filter(s=>s.setId===original.setId).length,1,'six attempt records produce one group entry');
      assert.deepEqual(history.dailySets!.map(s=>[s.date,s.scope]),[['2026-11-02','math'],['2026-11-03','math']]);
      assert.ok(history.dailySets!.every(s=>Object.keys(s).sort().join(',')==='createdAt,date,scope,setId'));
      const storage=new Map<string,string>(),local={getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,v);},removeItem:(k:string)=>{storage.delete(k);}};
      const q=await d.question(nextId),v=await d.view(nextId),binding={familyId:h.familyId,learnerId,attemptId:nextId,releaseId:v.releaseId};
      const editor=new ActivityDrafts(binding,local);editor.readServer({...binding,questionInstanceId:q.questionInstanceId,version:v.version},(q.scene.state as ActivityState).draft);
      let selected:Promise<DailyProjection>|undefined;
      const nav=historyLinks(history,setId=>{selected=d.daily(setId);});assert.equal(elements(nav,e=>e.type==='button').length,2);
      const oldButton=button(nav,/2026-11-02 · 数学/);assert.equal(oldButton.props.type,'button');click(oldButton);
      const read=(await selected!)!.set!;assert.deepEqual(read,original);
      const html=renderToStaticMarkup(<DailySummary set={read} disabled={false} onHome={()=>{selected=d.daily();}} onPractice={()=>{throw Error('review must not start practice');}}/>);
      assert.match(html,/<dt>核对正确<\/dt><dd>5<\/dd>/);assert.match(html,/<dt>纠正后通过<\/dt><dd>1<\/dd>/);assert.match(html,/<dt>请求提示<\/dt><dd>1次<\/dd>/);
      const summary=DailySummary({set:read,disabled:false,onHome:()=>{selected=d.daily();},onPractice:()=>{throw Error('review must not start practice');}});
      click(button(summary,/回到学习首页/));const current=await selected!;assert.equal(current.set!.setId,next.setId);
      click(oldButton);assert.deepEqual((await selected!)!.set,original,'repeated history opening stays read-only');
      assert.deepEqual(facts(h),before,'review/home/review did not create, advance, submit, count or change drafts');
      let resumed:Promise<DailySetView>|undefined;
      const home=DailyHomeCard({value:current,scope:'math',disabled:false,activeOther:false,onStart:(scope,mode,previousSetId)=>{resumed=d.start(scope,mode,previousSetId);},onOpen:()=>{throw Error('unfinished home must continue its current group');},onReload:()=>{}});
      click(button(home,/继续上次练习/));const continued=await resumed!;assert.equal(continued.setId,next.setId);assert.equal(continued.items[0].attemptId,nextId);
      assert.deepEqual(continued.items.map(i=>[i.poolId,i.releaseId,i.taskVersion]),next.items.map(i=>[i.poolId,i.releaseId,i.taskVersion]));assert.equal((await d.view(nextId)).attemptStatus,'ACTIVE');
      const reopenedEditor=new ActivityDrafts(binding,local),afterQuestion=await d.question(nextId),afterView=await d.view(nextId);
      reopenedEditor.readServer({...binding,questionInstanceId:afterQuestion.questionInstanceId,version:afterView.version},(afterQuestion.scene.state as ActivityState).draft);
      assert.equal(reopenedEditor.getSnapshot().draft!.answerText,'{"q1":"0.04"}');assert.deepEqual(facts(h),before);
      const oldCard=renderToStaticMarkup(<DailyHomeCard value={{...current,set:original}} scope="math" disabled={false} activeOther={false} onStart={()=>{}} onOpen={()=>{}} onReload={()=>{}}/>);
      assert.match(oldCard,/建组时的安排理由/);assert.match(frozenReason,/还没有这题的核对记录/);assert.equal((await d.daily(original.setId)).set!.items[0].reason,frozenReason);
      const disabled=renderToStaticMarkup(historyLinks(history,()=>{},true));assert.equal((disabled.match(/disabled=""/g)??[]).length,2);
    });

    await t.test('history references and old-set queries reject another learner and another family',async()=>{
      await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});const other=await h.createLearner(await h.guardianContext(),'另一个合成学生');await h.enterLearner(other);
      const otherDriver=dailyDriver(h,other),otherCtx=await h.learnerContext(other);
      await assert.rejects(h.server.query(otherCtx,{kind:'learning.activityHistory',learnerId}),forbidden);await assert.rejects(otherDriver.daily(original.setId),forbidden);assert.equal((await otherDriver.history()).dailySets,undefined);
      await d.reenter();const foreign=await Harness.create({policy:dailyPolicy(),compiler:noRunCompiler()});
      try{const f=await initialize(foreign),ctx=await foreign.learnerContext(f.learnerId);await assert.rejects(foreign.server.query(ctx,{kind:'learning.activityHistory',learnerId}),forbidden);await assert.rejects(f.d.daily(original.setId),forbidden);assert.equal((await f.d.history()).dailySets,undefined);}finally{await foreign.closeAll();}
    });

    await t.test('deleted facts stay missing in the linked summary; removing the last retained item removes its history entry',async()=>{
      await removeAttempt(h,d,original.items[0].attemptId!);
      const history=await d.history();assert.equal(history.dailySets!.find(s=>s.setId===original.setId)!.date,'2026-11-02','frozen date survives a removed first attempt');
      let selected:Promise<DailyProjection>|undefined;click(button(historyLinks(history,setId=>{selected=d.daily(setId);}),/2026-11-02 · 数学/));
      const partial=(await selected!)!.set!;assert.equal(partial.items[0].state,'MISSING');assert.equal(partial.items[0].result,'NOT_CHECKED');assert.equal(partial.items[0].hintCount,0);assert.equal(partial.items[0].submissionCount,0);
      const html=renderToStaticMarkup(<DailySummary set={partial} disabled={false} onHome={()=>{}} onPractice={()=>{}}/>);
      assert.match(html,/原记录已移除/);assert.match(html,/<dt>纠正后通过<\/dt><dd>0<\/dd>/);assert.match(html,/<dt>请求提示<\/dt><dd>0次<\/dd>/);
      for(const item of original.items.slice(1))await removeAttempt(h,d,item.attemptId!);
      const remaining=await d.history();assert.deepEqual(remaining.dailySets!.map(s=>s.setId),[next.setId]);assert.doesNotMatch(renderToStaticMarkup(historyLinks(remaining,()=>{})),/2026-11-02/);
      await assert.rejects(d.daily(original.setId),forbidden);assert.equal((await d.daily()).set!.setId,next.setId);
      assert.equal(((await d.question(nextId)).scene.state as ActivityState).draft.answerText,'{"q1":"0.04"}');assert.deepEqual(h.storage.rawDatabase().prepare('PRAGMA foreign_key_check').all(),[]);
    });
  }finally{await h.closeAll();await rm(root,{recursive:true,force:true});}
});

test('GESP feedback follows each frozen public prompt; new feedback does not rewrite a saved R1 error',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rondo-daily-feedback-')),options={dbFile:join(root,'learning.sqlite'),contentRoot:join(root,'content'),policy:dailyPolicy(),compiler:noRunCompiler()};let h=await fixtureHarness(options);
  try{
    const initial=await initialize(h),learnerId=initial.learnerId;let d=initial.d;const set=await d.start('gesp'),first=set.items[0];assert.equal(first.lessonId,'gesp2.202303.mcq05');
    await d.answer(first,[{kind:'singleChoice',selectionId:first.lessonId,optionId:'A'}]);const saved=(await d.history()).attempts[0].cycles[0].submissions[0],now=h.clock.now();await h.closeAll();
    h=await reopen(options,now,learnerId);d=dailyDriver(h,learnerId);assert.deepEqual((await d.history()).attempts[0].cycles[0].submissions[0],saved);
    h.clock.advance(1000);
    await d.send('learning.reviseResponse',{},first.attemptId!);await d.answer(first,[{kind:'singleChoice',selectionId:first.lessonId,optionId:'A'}]);
    const submissions=(await d.history()).attempts[0].cycles[0].submissions;assert.equal(submissions.length,2);assert.deepEqual(submissions.find(s=>s.submissionId===saved.submissionId),saved);
    const updated=submissions.find(s=>s.submissionId!==saved.submissionId)!,feedback=updated.feedback as {itemResults:Array<{feedback:string}>;reveal?:unknown};assert.equal(updated.outcome,'REVISE');assert.match(feedback.itemResults[0].feedback,/关键字.*普通名字/);assert.doesNotMatch(feedback.itemResults[0].feedback,/引号|字符/);assert.equal(feedback.reveal,undefined);
    const sourceState=(await d.question(first.attemptId!)).scene.state as ActivityState;
    const relevant:Record<string,RegExp>={'mcq05':/关键字.*普通名字/,'mcq06':/斜杠.*反斜杠/,'mcq10':/赋值.*放回变量/,'tf05':/变量 a.*字符字面量 'a'/,'tf07':/第一次检查就不成立/,'tf08':/先后顺序.*交换符号/};
    for(const entry of DAILY_POOL.filter(e=>e.scope==='gesp')){
      const lesson=gespLessonForRelease(entry.releaseId,entry.taskId)!;assert.equal(entry.prompt,lesson.extractedText);
      const rule=h.content.getRuleBody(entry.releaseId,entry.taskId) as ActivityRule,state={...sourceState,gesp:{...sourceState.gesp!,questionId:entry.lessonId}};
      const correct=correctDailyResponse(entry);assert.equal(evaluateDailyShort(entry,rule,state,correct).outcome,'CORRECT');
      const answer=correct[0];assert.ok(answer.kind==='singleChoice');const wrong=answer.optionId==='A'?'B':answer.optionId==='T'?'F':answer.optionId==='F'?'T':'A';
      const evaluated=evaluateDailyShort(entry,rule,state,[{...answer,optionId:wrong}]);assert.equal(evaluated.outcome,'REVISE');
      const step=evaluated.feedback.itemResults?.[0].feedback;assert.ok(step);assert.match(step,relevant[entry.lessonId.split('.').at(-1)!]);
      if(entry.lessonId.endsWith('mcq10'))assert.equal(step,'再读符号的顺序；如果有赋值，要把结果放回变量。');
      if(entry.lessonId.endsWith('tf07'))assert.equal(step,'先看条件何时检查，再考虑第一次检查就不成立的情况。');
    }
    assert.equal((await d.history()).attempts.length,1,'other prompt checks are pure evaluations, not extra learner attempts');
  }finally{await h.closeAll();await rm(root,{recursive:true,force:true});}
});

test('optional history references accept legacy projections and contain no result or private grading fields',()=>{
  const old={kind:'learning.activityHistory',learnerId:'synthetic-learner',attempts:[]};assert.deepEqual(activityHistorySchema.parse(old),old);
  const reference={setId:'synthetic-set',date:'2026-11-02',scope:'gesp',createdAt:Date.parse('2026-11-02T04:00:00Z')};
  const current=activityHistorySchema.parse({...old,dailySets:[reference]});assert.equal(current.dailySets!.length,1);
  assert.throws(()=>activityHistorySchema.parse({...old,dailySets:[{...reference,correctAnswer:'B'}]}));
  const html=renderToStaticMarkup(<DailyHistoryLinks sets={[current.dailySets![0],current.dailySets![0]]} onOpen={()=>{}}/>);
  assert.equal((html.match(/<button/g)??[]).length,1);assert.match(html,/2026-11-02 · GESP客观题/);assert.match(html,/12:00 建组/);assert.match(html,/aria-label="回看日常题组与小结"/);
});
