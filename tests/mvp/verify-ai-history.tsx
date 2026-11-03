/** Read old AI-R1 facts through the real history projection and the actual read-only UI. */
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {renderToStaticMarkup} from 'react-dom/server';
import {Harness,GUARDIAN_PASSPHRASE} from '../fixtures/harness';
import {AI_ADDITIONAL_ACTIVITIES,AI_USE_CARDS} from '../../modules/curriculum/ai';
import {activityHistorySchema} from '../../modules/contracts/public/activity';
import {initialAILab} from '../../modules/contracts/public/ai-lab';
import {AILabHistory,aiOperationSummary} from '../../apps/web/src/studio/AILabs';
import {ActivityHistoryPanel} from '../../apps/web/src/app/Mvp';

const out=resolve('../delivery/ai-r2'),baseline=JSON.parse(readFileSync('../delivery/ai-r1/verification.json','utf8')) as {dataRoot:string;coverage:Array<{id:string;originalAttempt:string;freshAttempt:string}>},beforeHistory=JSON.parse(readFileSync('../delivery/ai-r1/history-before-reopen.json','utf8')) as {learnerId:string};
const root=mkdtempSync(resolve('.synthetic-data-ai-history-'));
copyFileSync(baseline.dataRoot+'/learning.sqlite',root+'/learning.sqlite');
const h=await Harness.create({dbFile:root+'/learning.sqlite',contentRoot:root+'/synthetic-content'});
const report:{status:string;dataRoot:string;coverage:unknown[];checks:string[];error?:string}={status:'RUNNING',dataRoot:root,coverage:[],checks:[]};
const db=h.storage.rawDatabase();
const facts=()=>createHash('sha256').update(JSON.stringify(['learningAttempt','learningCycle','submission','evaluation','learningEvent','commandReceipt'].map(name=>db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()))).digest('hex');
const text=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
try{
 const originalFacts=facts();
 for(const a of AI_ADDITIONAL_ACTIVITIES)await h.content.loadRelease(resolve('dist/content'),a.releaseId);
 await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});const ctx=await h.enterLearner(beforeHistory.learnerId);
 const history=activityHistorySchema.parse(await h.server.query(ctx,{kind:'learning.activityHistory',learnerId:beforeHistory.learnerId}));
 for(const a of AI_ADDITIONAL_ACTIVITIES){
  const recorded=baseline.coverage.find(x=>x.id===a.id)!,attempt=history.attempts.find(x=>x.attemptId===recorded.originalAttempt)!,cycle=attempt.cycles[0],lab=cycle.state.lab!;
  assert.ok(lab);assert.equal(cycle.submissions.length,3);
  for(const sub of cycle.submissions){const raw=db.prepare('SELECT stateSnapshotJson FROM submission WHERE submissionId=?').get(sub.submissionId) as {stateSnapshotJson:string};assert.deepEqual(sub.lab,JSON.parse(raw.stateSnapshotJson).lab);}
  const rawEvents=db.prepare("SELECT payloadJson FROM learningEvent WHERE attemptId=? AND eventType='OPERATION_COMMITTED' ORDER BY seq").all(attempt.attemptId) as Array<{payloadJson:string}>;
  const expectedEvents=rawEvents.map(x=>JSON.parse(x.payloadJson)).filter(x=>x.cycleId===cycle.cycleId&&x.operation.type!=='SaveActivityDraft');
  assert.deepEqual(cycle.operations?.map(x=>({operation:x.operation,labAfter:x.labAfter})),expectedEvents.map(x=>({operation:x.operation,labAfter:x.stateAfter.lab})));
  assert.notDeepEqual(cycle.submissions[0].lab,lab,'first submission must not acquire later experiment state');
  const repeat=history.attempts.find(x=>x.attemptId===recorded.freshAttempt)!;assert.deepEqual(repeat.cycles[0].state.lab,initialAILab(a.id));assert.deepEqual(history.attempts.find(x=>x.attemptId===recorded.originalAttempt)!.cycles[0].state.lab,lab);
  const markup=renderToStaticMarkup(<AILabHistory lab={lab}/>),visible=text(markup),summaries=cycle.operations!.map(op=>aiOperationSummary(op.operation,op.labAfter));
  switch(lab.kind){
   case'a1':assert.ok(visible.includes('规则搜索下棋'));break;
   case'a2':assert.ok(visible.indexOf('1955')<visible.indexOf('1956'));assert.ok(summaries.some(x=>x.includes('移到第1位')&&x.includes('当时顺序')));break;
   case'a3':assert.equal(lab.trials[0].predicted,'tall');assert.equal(lab.trials[1].predicted,'broad');assert.ok(visible.includes('例子版本1')&&visible.includes('例子版本2'));assert.ok(summaries.some(x=>x.includes('标签改为细长')));assert.ok(summaries.some(x=>x.includes('标签为舒展')));assert.ok(summaries.some(x=>x.includes('→ 细长'))&&summaries.some(x=>x.includes('→ 舒展')));assert.equal(cycle.operations!.find(op=>(op.operation as {type:string}).type==='TestAIClassifier')!.labAfter?.kind,'a3');break;
   case'a4':assert.ok(visible.includes('冻结的宽系数为2'));assert.ok(summaries.includes('冻结宽的系数：2'));assert.ok(summaries.some(x=>x.includes('宽的系数2 → 细长')));break;
   case'a5':assert.ok(visible.includes('3片')&&visible.includes('7片'));assert.ok(summaries.some(x=>x.includes('7片')));break;
   case'a6':assert.ok(visible.includes('上下文1')&&visible.includes('上下文2')&&visible.includes('指向：猫')&&visible.includes('指向：椅子'));assert.ok(summaries.some(x=>x.startsWith('上下文1：'))&&summaries.some(x=>x.startsWith('上下文2：')));break;
   case'a8':for(const card of AI_USE_CARDS)assert.ok(visible.includes(card.title));assert.ok(visible.includes('让AI辅助，自己核查和修改')&&visible.includes('自己完成，不输入这些资料')&&visible.includes('先问老师或可信成年人'));assert.ok(summaries.every(x=>x.includes('选择：')));break;
  }
  const complete=text(renderToStaticMarkup(<ActivityHistoryPanel history={{...history,attempts:[attempt]}}/>));assert.ok(complete.includes('这次活动最后保存的实验记录')&&complete.includes('这次回答提交时的实验记录'));assert.ok(complete.includes(visible));
  const fresh=text(renderToStaticMarkup(<AILabHistory lab={repeat.cycles[0].state.lab!}/>));assert.notEqual(fresh,visible);
  report.coverage.push({id:a.id,attemptId:attempt.attemptId,submissionSnapshots:cycle.submissions.length,operationSnapshots:cycle.operations!.length,historyText:visible,operationSummaries:summaries});
 }
 assert.equal(facts(),originalFacts,'history query must not rewrite learning facts');
 writeFileSync(out+'/history-readback.json',JSON.stringify(history,null,2));writeFileSync(out+'/history-render.html',renderToStaticMarkup(<ActivityHistoryPanel history={history}/>));
 report.checks.push('7/7 old AI-R1 attempts: every submission lab equals its persisted stateSnapshotJson; every operation labAfter equals its persisted event stateAfter; no replay or reconstruction','actual read-only history UI renders A2 order, A3 labeled examples/trials/versions, A4 frozen coefficients/results, A5 segmentations/counts, A6 both contexts/links/continuations, A8 specific plans','first submission stays distinct from later corrections; fresh reattempt retains independent initial state; old attempt remains unchanged','all inspected learning facts and receipts unchanged by queries; optional snapshot fields validated by public history schema');report.status='PASS';
}catch(e){report.status='FAIL';report.error=e instanceof Error?e.stack:String(e);throw e;}finally{writeFileSync(out+'/history-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));await h.closeAll();}
