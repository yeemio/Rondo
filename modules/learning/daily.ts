/** Server-only daily v1 organization and projections. All learning facts stay in their original tables. */
import {z} from 'zod';
import {dailyEntrySchema,dailyPlanSchema,type DailyEntry,type DailyPlan,type DailyScope,type DailySetView,type DailyItemView} from '../contracts/public/daily';
import {DAILY_POOL,dailyPoolEntry,type DailyPoolEntry} from '../curriculum/daily';
import {mathLessonForRelease} from '../curriculum/math6';
import type {Repositories,RepoScope,LearningAttemptRecord,LearningEventRecord,SubmissionRecord} from '../contracts/server/storage';
import type {ActivityRule} from '../contracts/server/rules-activity';
import type {ActivityState} from '../contracts/public/activity';
import type {StructuredResponseItem} from '../contracts/public/envelope';
import type {EvaluationResult} from './evaluate';
import {mathQuantityEqual} from './math6-evaluate';
import {rondoError} from '../contracts/public/errors';

const membershipSchema=z.object({version:z.literal('rondo.daily.v1'),setId:z.string().min(1),index:z.number().int().min(0).max(5),entry:dailyEntrySchema}).strict();
export type DailyMembership=z.infer<typeof membershipSchema>;
export interface StoredDailySet {plan:DailyPlan;links:Array<{index:number;attemptId:string}>;closed:boolean;}
export const dailyDate=(now:number)=>new Date(now+8*60*60*1000).toISOString().slice(0,10);
export function dailyEntrySnapshot(entry:DailyPoolEntry):DailyEntry {const {scope:_,...snapshot}=entry;return snapshot;}
export async function dailyEvents(scope:RepoScope,repos:Repositories,attemptId:string):Promise<LearningEventRecord[]> {
  const all:LearningEventRecord[]=[];let afterSeq=0;
  for(;;){const page=await repos.learningEvent.pageBySeq(scope,{attemptId,afterSeq,limit:200});all.push(...page);if(page.length<200)return all;afterSeq=page.at(-1)!.seq;}
}
export function parseDailyMembership(events:LearningEventRecord[],attempt:LearningAttemptRecord):DailyMembership|null {
  const event=events.find(e=>e.eventType==='DAILY_ITEM_STARTED');if(!event)return null;
  const parsed=membershipSchema.safeParse(JSON.parse(event.payloadJson));
  if(!parsed.success)throw rondoError('CONTENT_UNAVAILABLE','这次日常练习的版本暂不可读，请保留原记录。');
  const value=parsed.data,pool=dailyPoolEntry(value.entry.poolId);
  if(!pool||pool.releaseId!==attempt.releaseId||pool.releaseId!==value.entry.releaseId||pool.taskId!==value.entry.taskId||pool.taskVersion!==value.entry.taskVersion||pool.workflow!==value.entry.workflow||JSON.stringify(pool.questionIds)!==JSON.stringify(value.entry.questionIds))throw rondoError('CONTENT_UNAVAILABLE','这次日常练习的题目绑定暂不可用，原记录保留。');
  return value;
}
export async function dailyMembership(scope:RepoScope,repos:Repositories,attempt:LearningAttemptRecord):Promise<DailyMembership|null>{return parseDailyMembership(await dailyEvents(scope,repos,attempt.attemptId),attempt);}
export async function readDailySets(scope:RepoScope,repos:Repositories,learnerId:string):Promise<StoredDailySet[]> {
  const sets=new Map<string,StoredDailySet>();
  for(const attempt of await repos.learningAttempt.listByLearner(scope,learnerId)){
    const events=await dailyEvents(scope,repos,attempt.attemptId),created=events.find(e=>e.eventType==='DAILY_SET_CREATED'),snapshot=events.find(e=>e.eventType==='DAILY_SET_SNAPSHOT');
    if(!created&&!snapshot)continue;
    // Carry public organization metadata into the new real attempt. A retained current attempt does not depend on an aged-out first attempt.
    const inherited=snapshot?JSON.parse(snapshot.payloadJson) as {plan:unknown;links:Array<{index:number;attemptId:string}>}:null;
    const parsed=dailyPlanSchema.safeParse(created?JSON.parse(created.payloadJson):inherited?.plan);
    if(!parsed.success||created&&parsed.data.setId!==attempt.attemptId)throw rondoError('CONTENT_UNAVAILABLE','题组记录暂不可读；没有重新抽题或覆盖原组。');
    const links=[...(inherited?.links??[]),...events.filter(e=>e.eventType==='DAILY_ITEM_LINKED').map(e=>JSON.parse(e.payloadJson) as {index:number;attemptId:string})];
    if(links.length<1||links.length>6||links.some((l,i)=>l.index!==i||typeof l.attemptId!=='string')||new Set(links.map(l=>l.attemptId)).size!==links.length)throw rondoError('PERSISTENCE_FAILED','题组的顺序记录不完整，请保留原记录。');
    const candidate={plan:parsed.data,links,closed:events.some(e=>e.eventType==='DAILY_SET_FINISHED')},prior=sets.get(parsed.data.setId);
    if(!prior||candidate.links.length>prior.links.length||candidate.links.length===prior.links.length&&candidate.closed)sets.set(parsed.data.setId,candidate);
  }
  return [...sets.values()].sort((a,b)=>a.plan.createdAt-b.plan.createdAt||a.plan.setId.localeCompare(b.plan.setId));
}
export interface DailyFacts {result:DailyItemView['result'];submissionCount:number;hintCount:number;explanationRequested:boolean;lastOutcome:string|null;}
export async function dailyFacts(scope:RepoScope,repos:Repositories,attempt:LearningAttemptRecord,entry:DailyEntry):Promise<DailyFacts> {
  const empty:DailyFacts={result:'NOT_CHECKED',submissionCount:0,hintCount:0,explanationRequested:false,lastOutcome:null};
  const cycle=await repos.learningCycle.findCurrentByAttempt(scope,attempt.attemptId);if(!cycle)return empty;
  const instance=await repos.questionInstance.findById(scope,cycle.questionInstanceId);
  if(!instance||instance.releaseId!==entry.releaseId||instance.taskId!==entry.taskId||instance.taskVersion!==entry.taskVersion)return empty;
  const subs=await (repos.submission as Repositories['submission']&{listAllByCycle(s:RepoScope,id:string):Promise<SubmissionRecord[]>}).listAllByCycle(scope,cycle.cycleId);
  const evaluations=[];
  for(const sub of subs){const ev=await repos.evaluation.findOriginalBySubmission(scope,sub.submissionId);if(ev){
    const f=JSON.parse(ev.feedbackJson) as {itemResults?:Array<{key:string;verdict:string}>;assessmentMode?:{mode:string}};
    // A source lesson may contain other questions; only these registered item results support this short practice.
    const own=entry.lessonId.startsWith('math6.')?f.itemResults?.filter(x=>entry.questionIds.includes(x.key)):f.itemResults;
    if(entry.workflow==='daily.short.v1'&&(!own?.length||entry.lessonId.startsWith('math6.')&&own.length!==entry.questionIds.length))continue;
    const outcome=entry.workflow==='daily.short.v1'&&own?.length?(own.every(x=>x.verdict==='CORRECT')?'CORRECT':'REVISE'):ev.outcome;
    evaluations.push({outcome,observed:f.assessmentMode?.mode==='OBSERVATION_RECORDED'});
  }}
  const last=evaluations.at(-1),events=await dailyEvents(scope,repos,attempt.attemptId);
  return {result:!last?'NOT_CHECKED':last.observed?'OBSERVED':last.outcome==='CORRECT'?(evaluations.slice(0,-1).some(x=>x.outcome==='REVISE')?'CORRECTED':'CORRECT'):'REVIEW',
    submissionCount:evaluations.length,hintCount:(await repos.hintPresentation.listByCycle(scope,cycle.cycleId)).length,
    explanationRequested:events.some(e=>e.eventType==='DAILY_EXPLANATION_REQUESTED'),lastOutcome:last?.outcome??null};
}
export async function projectDailySet(scope:RepoScope,repos:Repositories,learnerId:string,set:StoredDailySet):Promise<DailySetView> {
  let unavailable=false;const items:DailyItemView[]=[];
  for(let i=0;i<set.plan.items.length;i++){
    const entry=set.plan.items[i],link=set.links[i];
    const item:DailyItemView={...entry,attemptId:link?.attemptId??null,state:'QUEUED',result:'NOT_CHECKED',submissionCount:0,hintCount:0,explanationRequested:false};
    if(link){
      const attempt=await repos.learningAttempt.findById(scope,link.attemptId);
      if(!attempt||attempt.learnerId!==learnerId){item.state='MISSING';if(!set.closed&&i===set.links.length-1)unavailable=true;}
      else{
        const member=await dailyMembership(scope,repos,attempt);
        if(!member||member.setId!==set.plan.setId||member.index!==i||member.entry.poolId!==entry.poolId)throw rondoError('PERSISTENCE_FAILED','题组记录与学习记录的绑定不一致。');
        item.state=attempt.attemptStatus==='ACTIVE'?'ACTIVE':attempt.attemptStatus==='PAUSED'?'PAUSED':attempt.attemptStatus==='COMPLETED'?'DONE':'BLOCKED';
        if(item.state==='BLOCKED')unavailable=true;
        const {lastOutcome:_,...facts}=await dailyFacts(scope,repos,attempt,entry);Object.assign(item,facts);
      }
    }
    items.push(item);
  }
  return {setId:set.plan.setId,version:set.plan.version,scope:set.plan.scope,date:set.plan.date,createdAt:set.plan.createdAt,practiceOf:set.plan.practiceOf,
    status:unavailable?'UNAVAILABLE':set.closed?'COMPLETE':'OPEN',currentIndex:set.closed?6:set.links.length-1,items};
}

/** Small deterministic selection, using actual prior checks/hint requests. No browser-provided scores. */
export async function selectDailyItems(scope:RepoScope,repos:Repositories,learnerId:string,subject:DailyScope,round:number):Promise<DailyPlan['items']> {
  const attempts=(await repos.learningAttempt.listByLearner(scope,learnerId)).slice().reverse();
  const candidates=[];
  for(const entry of DAILY_POOL.filter(e=>e.scope===subject)){
    let facts:DailyFacts|undefined;
    for(const attempt of attempts){
      if(attempt.releaseId!==entry.releaseId)continue;
      const member=await dailyMembership(scope,repos,attempt);if(member&&member.entry.poolId!==entry.poolId)continue;
      const checked=await dailyFacts(scope,repos,attempt,entry);if(checked.submissionCount){facts=checked;break;}
    }
    const revisit=!!facts&&(facts.result==='REVIEW'||facts.result==='CORRECTED'||facts.hintCount>0||facts.explanationRequested);
    candidates.push({entry,facts,revisit});
  }
  const reviewSkills=new Set(candidates.filter(c=>c.revisit).map(c=>c.entry.skill));
  const shorts=candidates.filter(c=>c.entry.workflow==='daily.short.v1');
  const rotated=[...shorts.slice(round%shorts.length),...shorts.slice(0,round%shorts.length)];
  rotated.sort((a,b)=>Number(b.revisit)-Number(a.revisit)||Number(reviewSkills.has(b.entry.skill))-Number(reviewSkills.has(a.entry.skill)));
  const chosen=subject==='math'?[...rotated.slice(0,5),...candidates.filter(c=>c.entry.workflow==='daily.model.v1').slice(0,1)]:rotated.slice(0,6);
  if(chosen.length!==6)throw rondoError('CONTENT_UNAVAILABLE','当前范围尚不足一组可用练习，请保留已有记录。');
  return chosen.map(({entry,facts,revisit})=>({...dailyEntrySnapshot(entry),reason:revisit?
    facts?.result==='REVIEW'?'上次这题仍有待修正的回答，先再试一次。':facts?.result==='CORRECTED'?'上次经过纠正后通过，再练一次检查这个关系。':'上次请求过提示或解析，这次再核对自己的回答。':
    reviewSkills.has(entry.skill)?'与待复练题同属“'+entry.skill+'”，接着练一个基础问题。':facts?'用原题再练一次；这次会保留新的回答，不覆盖以前的记录。':'还没有这题的核对记录，从一个条件明确的“'+entry.skill+'”问题开始。'}));
}

export function evaluateDailyShort(entry:DailyEntry,rule:ActivityRule,state:ActivityState,response:StructuredResponseItem[]):EvaluationResult {
  const pool=dailyPoolEntry(entry.poolId);
  if(!pool||pool.workflow!=='daily.short.v1')throw rondoError('INVALID_OPERATION','当前题目没有开放短练流程。');
  let items:Array<{key:string;label:string;verdict:'CORRECT'|'REVISE';feedback:string}>;
  if(entry.lessonId.startsWith('math6.')){
    const truth=rule.math,answer=response[0];
    if(!truth||truth.lessonId!==entry.lessonId||!state.math||state.math.lessonId!==entry.lessonId||truth.mode!=='score'||truth.modelEvidence||Object.keys(truth.construction).length||response.length!==1||answer.kind!=='mathAnswer'||answer.lessonId!==entry.lessonId||answer.answers.length!==entry.questionIds.length||new Set(answer.answers.map(x=>x.id)).size!==entry.questionIds.length||answer.answers.some(x=>!entry.questionIds.includes(x.id)))throw rondoError('INVALID_OPERATION','请只回答当前短练标明的问题；模型任务不能改用短练流程。');
    items=entry.questionIds.map(id=>{
      const check=truth.checks.find(c=>c.id===id),value=answer.answers.find(a=>a.id===id)!;
      if(!check)throw rondoError('CONTENT_UNAVAILABLE','当前短练的核对条件未登记。');
      const publicQuestion=mathLessonForRelease(entry.releaseId,entry.taskId)?.questions.find(q=>q.id===id);
      if(check.kind==='choice'&&(value.kind!=='choice'||!publicQuestion?.options?.some(option=>option.id===value.optionId)))throw rondoError('INVALID_OPERATION','请先选择当前题目提供的一项，再核对回答。');
      const ok=check.kind==='choice'?value.kind==='choice'&&check.accepted!.includes(value.optionId):mathQuantityEqual(value,check.value!,check.unit!);
      const nextStep:Record<string,string>={
        'math6.u1-03':'把0.8写成8/10，把0.03写成3/100；分子相乘、分母相乘，再核对积的小数位。',
        'math6.u1-06':'先比较0.99与1：把正数乘一个不足1的数，会取原数的一部分。再选择大小关系。',
        'math6.u1-08':'把被除数和除数同时扩大1000倍，再计算；用“商×0.017”检查是否回到0.34。',
        'math6.u1-05':'先算6.25×1.5，不在中途舍入；付款保留到分，观察第三位小数是否需要进位。',
        'math6.b17':'把一周360°当作整体，计算90÷360，并把分子与分母同时约去相同因数。',
        'math6.u1-09':'继续计算到第三位小数，用第三位决定第二位是否进位；本题按四舍五入取两位。',
        'math6.u1-10':'只能买整支笔。把你填写的支数乘3.5，检查是否超过300元，再检查多买一支是否够钱。',
      };
      return {key:id,label:check.label??id,verdict:ok?'CORRECT':'REVISE',feedback:ok?'这一项核对正确。':nextStep[entry.lessonId]??check.feedback};
    });
  }else{
    const truth=rule.gesp,answer=response[0];
    if(rule.activity!=='gesp-objective'||!truth||truth.questionId!==entry.lessonId||truth.acceptedAnswers.includes('ISSUE')||!state.gesp||state.gesp.questionId!==entry.lessonId||response.length!==1||answer.kind!=='singleChoice'||answer.selectionId!==entry.lessonId||!(entry.lessonId.includes('.tf')?['T','F']:['A','B','C','D']).includes(answer.optionId))throw rondoError('INVALID_OPERATION','请选择当前客观题的一项；整题前提有争议的题不在日常自动核对范围内。');
    const ok=truth.acceptedAnswers.some(option=>option===answer.optionId);
    // These four public prompts need different next steps despite sharing a skill label.
    // Existing evaluations retain their saved feedback; only a new check uses these messages.
    const nextStep:Record<string,string>={
      'gesp2.202303.mcq05':'检查各选项是语言保留的关键字，还是可用作函数或变量的普通名字；题目要选“不是关键字”的一项。',
      'gesp2.202303.mcq06':'核对每一项的两个符号能否组成 C++ 运算符；先分清斜杠 / 和反斜杠 \\，再留意题目问的是“不是”。',
      'gesp2.202303.tf05':"把变量 a 和字符字面量 'a' 分开：引号里写的是哪个字符？给变量赋值，会改变引号内的文字吗？",
      'gesp2.202303.tf08':'逐字比较题面两个符号的先后顺序；交换符号后，是否仍是 C++ 规定的运算符？',
    };
    items=[{key:entry.lessonId,label:'我的选择',verdict:ok?'CORRECT':'REVISE',feedback:ok?'这一项选择核对正确。':nextStep[entry.lessonId]??(entry.skill==='运算符'?'再读符号的顺序；如果有赋值，要把结果放回变量。':entry.skill==='循环条件'?'先看条件何时检查，再考虑第一次检查就不成立的情况。':'区分语言规定的名字、普通名称，以及引号内的字符。')}];
  }
  return {outcome:items.every(x=>x.verdict==='CORRECT')?'CORRECT':'REVISE',feedback:{ruleKind:'FAMILY_TRUTH_V1',scenarioMet:true,responseTypeOk:true,
    assessmentMode:{version:'daily.assessment.v1',mode:'SHORT_CHECKED'},itemResults:items,diagnostics:['只核对本次短练的回答；没有代填预测、模型记录或推演。'],
    reveal:{explanation:rule.explanation+'\n本次短练未要求也未代填完整课程的预测、模型记录或三栏推演；解析中的课程说明供对照。'}}};
}
