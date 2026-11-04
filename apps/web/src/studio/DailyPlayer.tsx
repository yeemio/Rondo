import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {AppPorts} from '../client/ports';
import type {DailyProjection,DailySetView,DailyItemView} from '../../../../modules/contracts/public/daily';
import type {PublicProjection} from '../../../../modules/contracts/public/queries';
import type {PublicQuestionSpec} from '../../../../modules/contracts/public/question';
import type {CommandKind,StructuredResponseItem} from '../../../../modules/contracts/public/envelope';
import type {CommandReceipt} from '../../../../modules/contracts/public/receipts';
import type {ActivityState,ActivityHistory} from '../../../../modules/contracts/public/activity';
import {dailyMathLesson} from '../../../../modules/curriculum/daily';
import {gespLessonForRelease} from '../../../../modules/curriculum/gesp';
import {MathModel,MathQuestions,mathResponseFromDraft,type MathFieldFeedback} from './Math6';
import {GespSource} from './Gesp';
import {StudioNav} from './Chrome';
import {LearningHints} from './AILabs';
import {ActivityDrafts,leaveActivityEditor,protectActivityUnload,type ActivityDraft} from './activity-drafts';
import {submitActivityPrediction} from './prediction';
import {useMvpCommand,CommandNotice} from './SessionNotice';
import {DailyProgress,DailySummary} from './DailyHome';
import {ActivityHistoryPanel} from '../app/Mvp';
import './daily.css';

type AttemptView=Extract<PublicProjection,{kind:'learning.attemptView'}>;
type Commands=ReturnType<typeof useMvpCommand>;
const errorText=(e:unknown)=>e&&typeof e==='object'&&'message'in e?String(e.message):String(e);

/** Only the public construction request and saved count; correct model targets stay on the server. */
export function DailyModelProgress({records,error}:{records:number;error:string}){
  return <section aria-label="两个圆的记录进度"><h2>按题意留下两个圆</h2><ol><li>先建半径3厘米的圆，检查半径线，保存记录。</li><li>再建直径3厘米的圆，检查直径线，保存记录。</li></ol><p>已保存 {records} 条记录。请比较两条线的长度，当前保留第二个完整的圆。</p><p className="footnote">保存记录后还要核对它是否符合题面要求；记录数量不代表任务已经完成。</p>{error?<p className="daily-field-error" role="alert">{error}</p>:null}</section>;
}

export function DailyPlayer({ports,learnerId,familyId,setId,onExit,onOpenSet,onSubject,onRegisterLeave}:{
  ports:AppPorts;learnerId:string;familyId:string;setId:string;onExit:()=>void;onOpenSet:(id:string)=>void;onSubject:(index:number)=>void;
  onRegisterLeave:(guard:(()=>Promise<boolean>)|null)=>void;
}){
  const command=useMvpCommand(ports,{familyId,learnerId}),[value,setValue]=useState<DailyProjection|null>(null),[history,setHistory]=useState<ActivityHistory|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  const readSeq=useRef(0);
  const load=useCallback(async()=>{const seq=++readSeq.current;try{
    const q=await ports.client.query({kind:'learning.daily',learnerId,setId});if(q.kind!=='learning.daily'||!q.set)throw Error('这组练习暂不可读，原记录没有被重抽。');
    const h=q.set.status!=='OPEN'?await ports.client.query({kind:'learning.activityHistory',learnerId}):null;
    if(seq!==readSeq.current)return;setValue(q);if(h?.kind==='learning.activityHistory')setHistory({...h,attempts:h.attempts.filter(a=>q.set!.items.some(i=>i.attemptId===a.attemptId))});setError('');setRevision(n=>n+1);
  }catch(e){if(seq===readSeq.current){setError(errorText(e));command.reportFailure(e);}}},[ports,learnerId,setId]);
  useEffect(()=>{setValue(null);void load();return()=>{readSeq.current++;};},[load]);
  const blocked=command.busy||command.recovering||command.needsReentry||!!command.pending;
  const retry=async()=>{await command.retry();await load();};
  const practice=async()=>{if(!value?.set||blocked)return;const receipt=await command.send('learning.startDaily',{scope:value.set.scope,mode:'practice',previousSetId:value.set.setId},{scope:'LEARNER',learnerId});if(receipt?.status==='APPLIED'){const id=receipt.effectRefs.find(x=>x.startsWith('daily:'))?.slice(6);if(id)onOpenSet(id);}};
  const set=value?.set,item=set?.items[set.currentIndex];
  useEffect(()=>{if(set?.status!=='OPEN')onRegisterLeave(null);if(set?.status==='COMPLETE')document.getElementById('daily-summary-title')?.focus();},[set?.status,onRegisterLeave]);
  return <><StudioNav active={set?.scope==='gesp'?1:0} onSelect={onSubject}/>
    {!set?<section className="daily-sheet"><p role="status">{error?'这组练习暂时没有读回。':'正在找回这组练习…'}</p><button className="text-button" disabled={blocked} onClick={()=>void load()}>重新读取原组</button></section>:set.status==='COMPLETE'?<DailySummary set={set} onHome={onExit} onPractice={()=>void practice()} disabled={blocked}/>:set.status==='UNAVAILABLE'?<section className="daily-sheet"><h1>原记录仍分开保留。</h1><p>当前需要的记录已移除或暂不可用，不能把本组算作完成。</p><DailyProgress set={set}/><button className="secondary-button" disabled={blocked} onClick={()=>void practice()}>另开一组复练</button><button className="text-button" onClick={onExit}>回到学习首页</button></section>:item?.attemptId?<>
      <DailyProgress set={set}/><DailyQuestion key={item.attemptId} ports={ports} familyId={familyId} learnerId={learnerId} set={set} item={item} command={command} revision={revision} onChanged={load} onExit={onExit} onRegisterLeave={onRegisterLeave}/>
    </>:null}
    {error?<p className="form-recovery" role="alert">{error}<button className="text-button" onClick={()=>void load()}>重新读取</button></p>:null}
    <CommandNotice command={command} onRetry={()=>void retry()} onRecovered={()=>void load()}/>
    {history?<ActivityHistoryPanel history={history}/>:null}
  </>;
}

function DailyQuestion({ports,familyId,learnerId,set,item,command,revision,onChanged,onExit,onRegisterLeave}:{
  ports:AppPorts;familyId:string;learnerId:string;set:DailySetView;item:DailyItemView;command:Commands;revision:number;
  onChanged:()=>Promise<void>;onExit:()=>void;onRegisterLeave:(guard:(()=>Promise<boolean>)|null)=>void;
}){
  const attemptId=item.attemptId!,releaseId=item.releaseId,short=item.workflow==='daily.short.v1',math=dailyMathLesson(item),gesp=gespLessonForRelease(item.releaseId,item.taskId);
  const editor=useMemo(()=>new ActivityDrafts({familyId,learnerId,attemptId,releaseId},localStorage),[familyId,learnerId,attemptId,releaseId]);
  const [editing,setEditing]=useState(editor.getSnapshot),[view,setView]=useState<AttemptView|null>(null),[spec,setSpec]=useState<PublicQuestionSpec|null>(null),[cycle,setCycle]=useState<ActivityHistory['attempts'][number]['cycles'][number]|null>(null),[error,setError]=useState(''),[modelError,setModelError]=useState(''),[leaving,setLeaving]=useState(false);
  const latest=useRef<{view:AttemptView|null;spec:PublicQuestionSpec|null;failed:boolean}>({view:null,spec:null,failed:false}),readSeq=useRef(0),leavingNow=useRef(false),heading=useRef<HTMLHeadingElement>(null),feedbackFocus=useRef<HTMLDivElement>(null);
  useEffect(()=>{setEditing(editor.getSnapshot());return editor.subscribe(setEditing);},[editor]);
  const load=useCallback(async(ownSaved?:ActivityDraft)=>{const seq=++readSeq.current;try{
    const v=await ports.client.query({kind:'learning.attemptView',attemptId});
    if(v.kind!=='learning.attemptView'||v.learnerId!==learnerId||v.releaseId!==releaseId||v.daily?.setId!==set.setId||v.daily.index!==set.currentIndex||!v.currentCycle)throw Error('当前题目已有变化，请读回原组再继续。');
    const [q,h]=await Promise.all([ports.client.query({kind:'learning.questionView',attemptId}),ports.client.query({kind:'learning.activityHistory',learnerId})]);
    if(q.kind!=='learning.questionView'||h.kind!=='learning.activityHistory')throw Error('当前回答暂不可读。');
    if(seq!==readSeq.current||latest.current.view&&v.version<latest.current.view.version)return false;
    const matched=editor.readServer({familyId,learnerId,attemptId,releaseId,questionInstanceId:q.spec.questionInstanceId,version:v.version},(q.spec.scene.state as ActivityState).draft,ownSaved);
    latest.current={view:v,spec:q.spec,failed:false};setView(v);setSpec(q.spec);setCycle(h.attempts.find(a=>a.attemptId===attemptId)?.cycles.find(c=>c.cycleId===v.currentCycle!.cycleId)??null);setError('');return matched;
  }catch(e){if(seq===readSeq.current){latest.current.failed=true;setError(errorText(e));command.reportFailure(e);}return false;}},[ports,learnerId,familyId,attemptId,releaseId,set.setId,set.currentIndex,editor]);
  useEffect(()=>{void load();return()=>{readSeq.current++;};},[load,revision]);
  useEffect(()=>{heading.current?.focus();},[view?.attemptId]);
  useEffect(()=>{if(cycle?.submissions.length)feedbackFocus.current?.focus();},[cycle?.submissions.at(-1)?.submissionId]);
  const send=useCallback(async(kind:CommandKind,payload:unknown,version?:number):Promise<CommandReceipt|null>=>{
    const current=latest.current;if(!current.view||!current.spec||current.failed)return null;
    const receipt=await command.send(kind,payload,{scope:'LEARNER',learnerId,attemptId},version??current.view.version,{releaseId,questionInstanceId:current.spec.questionInstanceId,rendererContractVersion:'1'});
    if(receipt?.status!=='APPLIED'){
      if(!command.getSnapshot().pending)await load();
      if(!short&&kind==='learning.submitResponse'&&receipt?.errorCode==='INVALID_OPERATION')setModelError('模型记录还没有符合题面的两个圆。先按半径线核对第一个，再按直径线核对第二个；依次保存，并保留第二个完整圆后再试。');
      return null;
    }
    if(kind==='learning.advanceDaily'){await onChanged();return receipt;}
    const operation=(payload as {operation?:{type?:string;draft?:ActivityDraft}}).operation;
    if(!await load(operation?.type==='SaveActivityDraft'?operation.draft:undefined))return null;
    if(kind==='learning.submitResponse'||kind==='learning.commitOperation'&&operation?.type!=='SaveActivityDraft')setModelError('');
    if(['learning.submitResponse','learning.requestHint','learning.revealDaily','learning.resumeAttempt','learning.pauseAttempt'].includes(kind))await onChanged();
    return receipt;
  },[command.send,load,learnerId,attemptId,releaseId,onChanged,short]);
  const save=useCallback(async()=>{const draft=editor.getSnapshot().draft;return draft?send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:{...draft}}}):null;},[editor,send]);
  const leave=useCallback(async()=>{if(leavingNow.current)return false;leavingNow.current=true;setLeaving(true);try{
    return await leaveActivityEditor({state:()=>{const e=editor.getSnapshot(),c=command.getSnapshot();return {dirty:e.dirty,locallyStored:e.locallyStored,pending:!!c.pending,busy:c.busy||c.recovering||latest.current.failed,needsReentry:c.needsReentry,active:latest.current.view?.attemptStatus==='ACTIVE'};},save,notice:editor.note});
  }finally{leavingNow.current=false;setLeaving(false);}},[editor,command.getSnapshot,save]);
  useEffect(()=>{onRegisterLeave(leave);return()=>onRegisterLeave(null);},[leave,onRegisterLeave]);
  useEffect(()=>{const protect=(event:BeforeUnloadEvent)=>{const e=editor.getSnapshot(),c=command.getSnapshot();protectActivityUnload(event,{dirty:e.dirty,locallyStored:e.locallyStored,pending:!!c.pending,busy:c.busy||c.recovering});};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[editor,command.getSnapshot]);
  const draft=editing.draft;
  if(!draft||!view||!spec)return <section className="daily-sheet"><p role="status">正在读取这道题与保存的回答…</p>{error?<p role="alert">{error}<button className="text-button" onClick={()=>void load()}>重新读取这道题</button></p>:null}</section>;
  const active=view.attemptStatus==='ACTIVE',phase=view.currentCycle!.phase,state=spec.scene.state as ActivityState,last=cycle?.submissions.at(-1);
  const blocked=leaving||latest.current.failed||command.busy||command.recovering||command.needsReentry||!!command.pending;
  const answers:Record<string,string>=(()=>{try{return JSON.parse(draft.answerText);}catch{return {};}})();
  const answer=(key:string,value:string)=>{editor.edit('answerText',JSON.stringify({...answers,[key]:value}));setError('');};
  const feedback=last?.feedback as {itemResults?:MathFieldFeedback[];reveal?:{explanation?:string}}|undefined;
  const canDefer=last?.outcome==='REVISE'&&(cycle?.submissions.length??0)>=2;
  const canClose=last?.outcome==='CORRECT'||canDefer;
  const modelReady=short||(state.math?.trials.length??0)>=2;
  async function submit(){
    let response:StructuredResponseItem[];
    if(math){const value=mathResponseFromDraft(math,answers);if(!value){setError('请补全当前回答；整数、小数或分数都可以，分母不能为0。');return;}response=[value];}
    else {if(!answers.gespChoice){setError('先选择一个答案，再核对。');return;}response=[{kind:'singleChoice',selectionId:item.lessonId,optionId:answers.gespChoice}];}
    const saved=await save();if(saved)await send('learning.submitResponse',{response},saved.attemptVersion);
  }
  async function advance(defer:boolean){if(!await leave())return;await send('learning.advanceDaily',{setId:set.setId,index:set.currentIndex,defer});}
  async function pause(){if(!await leave())return;const receipt=await send('learning.pauseAttempt',{});if(receipt&&!editor.getSnapshot().dirty)onExit();}
  const nextText=set.currentIndex===5?'看本组小结':'下一题';
  return <article className="daily-sheet"><header><p className="daily-eyebrow">{set.date} · 第 {set.currentIndex+1} / 6 题 · {short?'短练':'操作与比较'}</p><h1 ref={heading} tabIndex={-1}>{item.title}</h1><p className={gesp?'daily-source-text':'intro'}>{item.prompt}</p><p className="footnote">{item.scopeNote}</p></header>
    {!active?<section><h2>{view.attemptStatus==='PAUSED'?'接着原来的回答继续。':'这题的记录已保存。'}</h2>{view.attemptStatus==='PAUSED'?<button className="primary-button" disabled={blocked} onClick={()=>void send('learning.resumeAttempt',{})}>继续这道题 →</button>:<button className="primary-button" disabled={blocked} onClick={()=>void advance(last?.outcome==='REVISE')}>{nextText} →</button>}</section>:null}
    {active&&!short&&phase==='PREDICT'?<form onSubmit={e=>{e.preventDefault();void submitActivityPrediction({activityId:'math6',draft,save,send});}}><label>先猜一猜：半径3厘米与直径3厘米的圆，大小会一样吗？<textarea required value={draft.prediction} maxLength={2000} disabled={blocked} onChange={e=>editor.edit('prediction',e.target.value)} placeholder="先写下自己的想法，随后用模型检查。"/></label><label><input type="checkbox" checked={draft.uncertain===true} disabled={blocked} onChange={e=>editor.edit('uncertain',e.target.checked)}/>我还不确定，想试试看</label><div className="daily-actions"><button className="primary-button" disabled={blocked||!draft.prediction.trim()}>保存猜想，开始操作 →</button></div></form>:null}
    {!short&&math&&state.math?<><DailyModelProgress records={state.math.trials.length} error={modelError}/><MathModel lesson={math} state={state.math} disabled={!active||phase!=='OPERATE'||blocked} onOperation={operation=>void send('learning.commitOperation',{operation})}/></>:null}
    {phase!=='PREDICT'?<form onSubmit={e=>{e.preventDefault();if(active&&phase==='OPERATE'&&!blocked)void submit();}}>
      {math?<MathQuestions lesson={math} short={short} answers={answers} onAnswer={answer} disabled={!active||phase!=='OPERATE'||blocked} feedback={feedback?.itemResults}/>:<fieldset className="daily-choice-list" disabled={!active||phase!=='OPERATE'||blocked}><legend>我的选择</legend>{(gesp?.kind==='tf'?['T','F']:['A','B','C','D']).map(option=><label key={option}><input type="radio" name={'daily-choice-'+attemptId} checked={answers.gespChoice===option} onChange={()=>answer('gespChoice',option)} aria-describedby={last?'daily-choice-feedback':undefined}/>{option==='T'?'正确':option==='F'?'错误':option}</label>)}</fieldset>}
      {!math&&feedback?.itemResults?.length?<div className="daily-feedback" id="daily-choice-feedback" data-verdict={feedback.itemResults[0].verdict}><strong>{feedback.itemResults[0].verdict==='CORRECT'?'这一项核对正确':'这一项需要修正'} · 上次提交</strong>{feedback.itemResults[0].feedback}</div>:null}
      {active&&phase==='OPERATE'?<div className="daily-actions"><button type="submit" className="primary-button" disabled={blocked||!modelReady}>{last?'提交修改，再核对':'核对回答'} →</button>{!modelReady?<p className="footnote">先完成上方两个圆的记录，再核对回答。</p>:null}</div>:null}
    </form>:null}
    {last?<div ref={feedbackFocus} tabIndex={-1} className="daily-feedback-zone" aria-label="这次反馈"><p>{last.outcome==='CORRECT'?'本次回答核对正确。':last.outcome==='REVISE'?'请看回答旁的提示，保留原来的尝试，再改一次。':'这次尚未得到可核对的结果。'}</p></div>:null}
    {active&&phase==='VERIFY'?<div className="daily-actions">
      {last?.outcome==='REVISE'?<button className="primary-button" disabled={blocked} onClick={()=>void send('learning.reviseResponse',{})}>再试一次 →</button>:null}
      {short&&last?.outcome==='CORRECT'?<button className="primary-button" disabled={blocked} onClick={()=>void advance(false)}>{nextText} →</button>:null}
      {short&&canDefer?<button className="secondary-button" disabled={blocked} onClick={()=>void advance(true)}>留待复练，{nextText} →</button>:null}
      {!short&&canClose?<button className="secondary-button" disabled={blocked} onClick={()=>void send('learning.beginExplanation',{})}>解释两个圆的比较 →</button>:null}
      {short&&!feedback?.reveal?<button className="text-button" disabled={blocked} onClick={()=>void send('learning.revealDaily',{})}>看这题的解析</button>:null}
    </div>:null}
    {active&&!short&&(phase==='EXPLAIN'||phase==='REVIEW')?<section><h2>用两个记录说明发现</h2><label>引用分别满足两种要求的模型记录，说明半径线与直径线的关系，以及为什么两个“3厘米”不是同一种要求。<textarea value={draft.explanation} maxLength={4000} disabled={blocked} onChange={e=>editor.edit('explanation',e.target.value)} placeholder="把自己的比较依据写清楚；不确定的地方也可以保留。"/></label>
      <div className="daily-actions"><button className="secondary-button" disabled={blocked||draft.explanation.trim().length<8} onClick={()=>void save().then(saved=>saved&&send('learning.saveExplanation',{selections:[],freeText:editor.getSnapshot().draft!.explanation,transcribedByGuardian:false},saved.attemptVersion))}>保存我的解释</button>
      {phase==='REVIEW'?<button className="primary-button" disabled={blocked||editing.dirty} onClick={()=>void advance(last?.outcome==='REVISE')}>{last?.outcome==='REVISE'?'留待复练，':''}{nextText} →</button>:null}</div><p className="footnote">请写成能读懂的一句话（至少8个字）；系统保留原文，不自动认定解释正确或已经掌握。</p>
    </section>:null}
    {feedback?.reveal?.explanation?<details open><summary>对照解析</summary><p className="daily-source-text">{feedback.reveal.explanation}</p></details>:null}
    <LearningHints hints={cycle?.hints??[]} disabled={blocked||!active||!['OPERATE','VERIFY'].includes(phase)} onRequest={level=>void send('learning.requestHint',{hintLevel:level})}/>
    {cycle?.submissions.length?<details><summary>回看这题的每次回答 · {cycle.submissions.length}次</summary>{cycle.submissions.map((s,i)=><section key={s.submissionId}><h3>第{i+1}次 · {s.outcome==='CORRECT'?'核对正确':s.outcome==='REVISE'?'需要修正':'尚未核对'}</h3><DailyAnswerText response={s.response} item={item}/></section>)}</details>:null}
    <details><summary>题目来源与建组时的安排理由</summary><p>{item.reason}</p><p>{item.selectionBasis}</p>{math?<p>{math.sourceNote}</p>:gesp?<GespSource lesson={gesp} compact/>:null}</details>
    {error?<p className="daily-field-error" role="alert">{error}</p>:null}
    {editing.notice?<p className="save-notice" role="status">{editing.notice}</p>:null}{editing.storageError?<p className="form-recovery" role="alert">{editing.storageError}</p>:null}
    {editing.retainedDraft?<details><summary>保留的较早编辑，可复制核对</summary>{(['prediction','answerText','explanation'] as const).map(key=><label key={key}>{key==='prediction'?'猜想':key==='answerText'?'回答':'解释'}<textarea readOnly value={editing.retainedDraft![key]}/></label>)}<button className="text-button" onClick={editor.discardRetained}>清除这份较早的本机草稿</button></details>:null}
    <footer><p role="status">{command.busy?'正在确认保存…':editing.dirty?(editing.locallyStored?'编辑已暂存本机，尚未保存为学习记录。':'当前编辑尚未保存，请先保留。'):'已读回保存的回答。'}</p><div className="daily-actions">{active?<><button className="quiet-button" disabled={blocked} onClick={()=>void save()}>保存当前编辑</button><button className="quiet-button" disabled={blocked} onClick={()=>void pause()}>暂停这组</button></>:null}<button className="quiet-button" disabled={leaving} onClick={()=>void leave().then(ok=>{if(ok)onExit();})}>保存并返回首页</button></div></footer>
  </article>;
}
export function DailyAnswerText({response,item}:{response:unknown;item:DailyItemView}){
  const values=Array.isArray(response)?response:[];
  return <>{values.map((value,i)=>value.kind==='singleChoice'?<p key={i}>我的选择：{value.optionId==='T'?'正确':value.optionId==='F'?'错误':value.optionId}</p>:value.kind==='mathAnswer'?value.answers.map((answer:{id:string;kind:string;optionId?:string;unit?:string;value?:{kind:string;value?:string;numerator?:string;denominator?:string}})=>{
    const q=dailyMathLesson(item)?.questions.find(q=>q.id===answer.id);
    return <p key={answer.id}>{q?.label}：{answer.kind==='choice'?q?.options?.find(o=>o.id===answer.optionId)?.label:answer.value?.kind==='fraction'?answer.value.numerator+'/'+answer.value.denominator:answer.value?.value}{answer.unit&&answer.unit!=='unitless'?' '+answer.unit:''}</p>;
  }):null)}</>;
}
