import type { RondoClient } from '../../../../modules/contracts/public/client';
import type { PublicProjection } from '../../../../modules/contracts/public/queries';
import type { ActivityHistory } from '../../../../modules/contracts/public/activity';
import type { CommandKind } from '../../../../modules/contracts/public/envelope';
import type { CommandReceipt } from '../../../../modules/contracts/public/receipts';

type AttemptView = Extract<PublicProjection, {kind:'learning.attemptView'}>;
export type NavigationSnapshot = { history:ActivityHistory; active:AttemptView|null };
export type NavigationSend = (kind:CommandKind,payload:unknown,target:unknown,version?:number)=>Promise<CommandReceipt|null>;

/** Choose an unfinished attempt only from the selected release, preferring its active attempt. */
export function selectedCourseAttempt(history:ActivityHistory,releaseId:string):ActivityHistory['attempts'][number]|undefined {
 return history.attempts.filter(a=>a.releaseId===releaseId&&(a.status==='ACTIVE'||a.status==='PAUSED'))
  .sort((a,b)=>Number(b.status==='ACTIVE')-Number(a.status==='ACTIVE')||b.startedAt-a.startedAt||b.attemptId.localeCompare(a.attemptId))[0];
}

export async function readCourseNavigation(client:RondoClient,learnerId:string):Promise<NavigationSnapshot> {
 const [history,point]=await Promise.all([client.query({kind:'learning.activityHistory',learnerId}),client.query({kind:'learning.resumePoint',learnerId})]);
 if(history.kind!=='learning.activityHistory'||point.kind!=='learning.resumePoint')throw Error('暂时无法读取课程目录，请保留当前记录并重试。');
 let active:AttemptView|null=null;
 if(point.attempt){const view=await client.query({kind:'learning.attemptView',attemptId:point.attempt.attemptId});if(view.kind!=='learning.attemptView')throw Error('暂时无法核对进行中的课程。');if(view.attemptStatus==='ACTIVE')active=view;}
 return {history,active};
}

/** A click explicitly names the active attempt it may pause; a changed active course requires a new choice. */
export async function enterSelectedCourse({client,send,learnerId,releaseId,reviewedActiveId}:{
 client:RondoClient;send:NavigationSend;learnerId:string;releaseId:string;reviewedActiveId:string|null;
}):Promise<{attemptId:string;releaseId:string}|null> {
 const snapshot=await readCourseNavigation(client,learnerId);
 const selected=selectedCourseAttempt(snapshot.history,releaseId);
 const other=snapshot.active?.releaseId!==releaseId?snapshot.active:null;
 if(other){
  if(other.attemptId!==reviewedActiveId)throw Error('正在进行的课程已有变化，请重新核对目录和切课按钮后再试。');
  const paused=await send('learning.pauseAttempt',{},{scope:'LEARNER',learnerId,attemptId:other.attemptId},other.version);
  if(!paused)return null;if(paused.status!=='APPLIED')throw Error('原课程尚未暂停，暂时没有进入另一课。');
 }
 let attemptId=selected?.attemptId??(snapshot.active?.releaseId===releaseId?snapshot.active.attemptId:undefined);
 if(attemptId){
  const view=await client.query({kind:'learning.attemptView',attemptId});
  if(view.kind!=='learning.attemptView'||view.releaseId!==releaseId)throw Error('所选课程记录已有变化，请重新读取目录。');
  if(view.attemptStatus==='PAUSED'){
   const resumed=await send('learning.resumeAttempt',{},{scope:'LEARNER',learnerId,attemptId},view.version);
   if(!resumed)return null;if(resumed.status!=='APPLIED')throw Error('所选课程尚未恢复，原记录仍保留。');
  }else if(view.attemptStatus!=='ACTIVE')throw Error('这次学习已结束，请重新读取目录后选择重练。');
 }else{
  const started=await send('learning.startAttempt',{releaseId},{scope:'LEARNER',learnerId});
  if(!started)return null;if(started.status!=='APPLIED')throw Error('所选课程尚未开始，原学习记录仍保留。');
  attemptId=started.effectRefs.find(ref=>ref.startsWith('attempt:'))?.slice(8);
 }
 if(!attemptId)throw Error('尚未确认所选课程的学习记录，请重新读取目录。');
 const opened=await client.query({kind:'learning.attemptView',attemptId});
 if(opened.kind!=='learning.attemptView'||opened.learnerId!==learnerId||opened.releaseId!==releaseId||opened.attemptStatus!=='ACTIVE')throw Error('暂时无法确认所选课程已打开，请重新读取目录。');
 return {attemptId:opened.attemptId,releaseId:opened.releaseId};
}

export interface CatalogueSelection {aiUnit:number;gespQuestionId:string;mathLessonId:string;}
/** Only public course identifiers, scoped to this family/learner, are kept across a catalogue remount. */
export function restoreCatalogueSelection(raw:string|null,defaults:CatalogueSelection):CatalogueSelection {
 try{const v=JSON.parse(raw??'null') as Partial<CatalogueSelection>|null;return v&&Number.isInteger(v.aiUnit)&&typeof v.gespQuestionId==='string'&&typeof v.mathLessonId==='string'?{aiUnit:v.aiUnit!,gespQuestionId:v.gespQuestionId,mathLessonId:v.mathLessonId}:defaults;}catch{return defaults;}
}
