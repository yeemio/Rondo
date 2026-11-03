/** Isolated synthetic daily scenes. Never points at an existing family or invokes a compiler. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {Harness,GUARDIAN_PASSPHRASE,type HarnessOptions} from './harness';
import {applyReleaseStatusChange} from '../../modules/learning/maintenance';
import {DAILY_POOL} from '../../modules/curriculum/daily';
import {parsePublicProjection} from '../../modules/contracts/public/queries';
import {parseEnvelope,type CommandKind,type StructuredResponseItem,type PublicCommandEnvelope} from '../../modules/contracts/public/envelope';
import type {DailyScope,DailyItemView} from '../../modules/contracts/public/daily';
import type {ActivityState} from '../../modules/contracts/public/activity';
import type {RondoClient} from '../../modules/contracts/public/client';
import type {CompilerService} from '../../workers/cpp/compiler.mjs';

export function dailyPolicy(){return {courseGraph:DAILY_POOL.map(e=>({taskId:e.taskId,nextTaskIds:[]})),hintPolicy:DAILY_POOL.map(e=>({taskId:e.taskId,maxLevel:2})),defaultRetention:{mode:'UNTIL_GUARDIAN_DELETES' as const}};}
export function noRunCompiler():CompilerService {
  return {verify:async()=>{},capability:()=>({available:false,instanceId:'synthetic-no-run'}),submit:()=>{throw Error('This daily fixture must not compile.');},read:()=>null,cancel:async()=>null,close:async()=>{}};
}
export async function loadDailyReleases(h:Harness,extra:string[]=[],contentRoot=resolve('dist/content')){
  for(const releaseId of new Set([...DAILY_POOL.map(e=>e.releaseId),...extra])){
    await h.content.loadRelease(contentRoot,releaseId);
    for(const [from,to] of [['DRAFT','REVIEWED'],['REVIEWED','AVAILABLE']] as const){
      if(h.content.releaseStatus(releaseId)===from)await applyReleaseStatusChange(h.storage,()=>h.clock.now(),{releaseId,to,reason:'isolated synthetic daily verification'});
    }
  }
}
export async function readyDaily(options:HarnessOptions={}){
  const h=await Harness.create({...options,policy:dailyPolicy(),compiler:noRunCompiler()});
  try{
    await loadDailyReleases(h);await h.setupFamily('每日练习·合成家庭');
    const learnerId=await h.createLearner(await h.guardianContext(),'合成六年级学生');await h.enterLearner(learnerId);
    return {h,learnerId,d:dailyDriver(h,learnerId)};
  }catch(e){await h.closeAll();throw e;}
}
export function dailyDriver(h:Harness,learnerId:string){
  let serial=0;const tag=h.ids.newId('daily-driver');
  const client:RondoClient={command:async e=>h.server.handleCommand(await h.learnerContext(learnerId),e),query:async q=>h.server.query(await h.learnerContext(learnerId),q),receipt:async q=>h.server.lookupReceipt(await h.learnerContext(learnerId),q),subscribeInvalidation:()=>()=>{}};
  async function daily(setId?:string){const q=await client.query({kind:'learning.daily',learnerId,...(setId?{setId}:{})});parsePublicProjection(q);assert.ok(q.kind==='learning.daily');return q;}
  async function view(attemptId:string){const q=await client.query({kind:'learning.attemptView',attemptId});assert.ok(q.kind==='learning.attemptView');parsePublicProjection(q);return q;}
  async function question(attemptId:string){const q=await client.query({kind:'learning.questionView',attemptId});assert.ok(q.kind==='learning.questionView');parsePublicProjection(q);return q.spec;}
  async function history(){const q=await client.query({kind:'learning.activityHistory',learnerId});assert.ok(q.kind==='learning.activityHistory');parsePublicProjection(q);return q;}
  async function envelope(kind:CommandKind,payload:unknown,attemptId?:string,key?:string):Promise<PublicCommandEnvelope>{
    const v=attemptId?await view(attemptId):null,q=attemptId?await question(attemptId):null;
    return parseEnvelope(h.envelope({kind,payload,idempotencyKey:key??tag+'-'+ ++serial,target:{scope:'LEARNER',learnerId,...(attemptId?{attemptId}:{})},...(v&&q?{expectedAttemptVersion:v.version,binding:{releaseId:v.releaseId,questionInstanceId:q.questionInstanceId,rendererContractVersion:'1'}}:{})}));
  }
  async function send(kind:CommandKind,payload:unknown,attemptId?:string,accept=true){const r=await client.command(await envelope(kind,payload,attemptId));if(accept)assert.equal(r.status,'APPLIED',kind+': '+JSON.stringify(r));return r;}
  async function start(scope:DailyScope='math',mode:'today'|'practice'='today',previousSetId?:string){const r=await send('learning.startDaily',{scope,mode,...(previousSetId?{previousSetId}:{})});return (await daily(r.effectRefs.find(x=>x.startsWith('daily:'))!.slice(6))).set!;}
  async function save(attemptId:string,changes:Partial<ActivityState['draft']>){const q=await question(attemptId);return send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:{...(q.scene.state as ActivityState).draft,...changes}}},attemptId);}
  async function answer(item:Pick<DailyItemView,'attemptId'|'lessonId'|'questionIds'>,response=correctDailyResponse(item)){return send('learning.submitResponse',{response},item.attemptId!);}
  async function advance(setId:string,index:number,defer=false){const s=(await daily(setId)).set!;return send('learning.advanceDaily',{setId,index,defer},s.items[index].attemptId!);}
  async function model(item:Pick<DailyItemView,'attemptId'>){
    const id=item.attemptId!;
    await send('learning.recordPrediction',{prediction:{kind:'activity.statement.v1',activityId:'math6',statement:'合成学生先猜：半径3厘米的圆可能更大，我要分别画出来比较。'},uncertain:true},id);
    for(const radius of [3,1.5]){await send('learning.commitOperation',{operation:{type:'SetMathControl',controlId:'radius',value:radius}},id);await send('learning.commitOperation',{operation:{type:'CaptureMathTrial'}},id);}
  }
  async function explain(item:Pick<DailyItemView,'attemptId'>){await send('learning.beginExplanation',{},item.attemptId!);await send('learning.saveExplanation',{selections:[],freeText:'合成学生比较：第一条记录半径3、直径6；第二条半径1.5、直径3。直径是两条半径，所以第二个圆更小。',transcribedByGuardian:false},item.attemptId!);}
  async function reenter(){await h.auth.unlockGuardian({passphrase:GUARDIAN_PASSPHRASE});await h.enterLearner(learnerId);}
  return {client,daily,view,question,history,envelope,send,start,save,answer,advance,model,explain,reenter};
}

/** Explicit synthetic answers, outside product imports; independent of private rule lookup. */
export function correctDailyResponse(item:Pick<DailyItemView,'lessonId'|'questionIds'>):StructuredResponseItem[]{
  const quantity=(id:string,value:string,unit='unitless')=>({kind:'quantity' as const,id,value:{kind:'decimal' as const,value},unit});
  const choices:Record<string,string>={'gesp2.202303.mcq05':'B','gesp2.202303.mcq06':'A','gesp2.202303.mcq10':'B','gesp2.202303.tf05':'F','gesp2.202303.tf07':'F','gesp2.202303.tf08':'T'};
  if(item.lessonId.startsWith('gesp2.'))return [{kind:'singleChoice',selectionId:item.lessonId,optionId:choices[item.lessonId]}];
  const answers:Record<string,Array<ReturnType<typeof quantity>|{kind:'choice';id:string;optionId:string}>>={
    'math6.u1-03':[quantity('q1','0.024')],'math6.u1-06':[{kind:'choice',id:'q3',optionId:'2'}],
    'math6.u1-08':[quantity('q2','20')],'math6.u1-05':[quantity('q1','9.38','元')],
    'math6.b17':[quantity('q1','0.25')],'math6.u1-09':[quantity('q2','3.18')],
    'math6.u1-10':[quantity('q1','85','支')],'math6.b16':[quantity('q1','6','厘米'),quantity('q2','1.5','厘米')],
  };
  return [{kind:'mathAnswer',version:'math.answers.v1',lessonId:item.lessonId,answers:answers[item.lessonId]}];
}
