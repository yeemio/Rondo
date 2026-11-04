import {parseEnvelope,type CommandKind,type PublicCommandEnvelope} from '../../../../modules/contracts/public/envelope';
import type {CommandReceipt} from '../../../../modules/contracts/public/receipts';
import type {LocalAuthPort} from '../../../../modules/contracts/public/auth';
import type {RondoClient} from '../../../../modules/contracts/public/client';
import type {CodeAvailability} from '../../../../modules/contracts/public/activity';
import {acknowledgeActivityDraft} from './activity-drafts';

/** Read-only admission check for this exact displayed question; never infer it from an old job. */
export async function readCodeAvailability(client:Pick<RondoClient,'query'>,attemptId:string,questionInstanceId:string):Promise<CodeAvailability>{
 const result=await client.query({kind:'code.availability',attemptId});
 if(result.kind!=='code.availability'||result.attemptId!==attemptId||result.questionInstanceId!==questionInstanceId)throw Error('当前编程题已有变化，请重新读取学习记录。');
 return result.availability;
}

export interface LearningIdentity {familyId:string;learnerId:string;}
interface DeliveryStore {getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void;}
export interface SessionCommandState {pending:PublicCommandEnvelope|null;busy:boolean;error:string;errorCode:string;needsReentry:boolean;recovering:boolean;recoveryError:string;recoveryNote:string;}
const errorCode=(e:unknown)=>e&&typeof e==='object'&&'code'in e?String(e.code):'';
const errorText=(e:unknown)=>e&&typeof e==='object'&&'message'in e?String(e.message):String(e);
function fail(code:string,message:string):never{throw Object.assign(new Error(message),{code});}

/** Delivery and re-entry only; ActivityDrafts retains unsent edits independently of the pending request. */
export class SessionCommands {
 private state:SessionCommandState={pending:null,busy:false,error:'',errorCode:'',needsReentry:false,recovering:false,recoveryError:'',recoveryNote:''};
 private listeners=new Set<(state:SessionCommandState)=>void>();
 private pendingIdentity:LearningIdentity;
 private key:string;
 constructor(private ports:{auth:LocalAuthPort;client:Pick<RondoClient,'command'>&Partial<Pick<RondoClient,'receipt'>>},private identity:LearningIdentity,private store:DeliveryStore){
  this.key='rondo.mvp.pending.'+identity.learnerId;this.pendingIdentity=identity;
  try{const raw=store.getItem(this.key);if(raw){const value=JSON.parse(raw) as {familyId?:string;learnerId?:string;envelope?:unknown};
   if(value.envelope){this.state.pending=parseEnvelope(value.envelope);this.pendingIdentity={familyId:value.familyId??'',learnerId:value.learnerId??''};}
   else this.state.pending=parseEnvelope(value); // r2 delivery envelope; no new draft store.
  }}catch{this.state.error='待确认的保存记录无法读取，请保留当前页面并重新进入。';}
 }
 getSnapshot=()=>this.state;
 subscribe=(listener:(state:SessionCommandState)=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private update(patch:Partial<SessionCommandState>){this.state={...this.state,...patch};for(const listener of this.listeners)listener(this.state);}
 reportFailure=(e:unknown)=>{const code=errorCode(e);this.update({error:errorText(e),errorCode:code,...(code==='UNAUTHENTICATED'?{needsReentry:true,recoveryNote:''}:{})});};
 private assertPendingScope(envelope:PublicCommandEnvelope){
  if(this.pendingIdentity.familyId!==this.identity.familyId||this.pendingIdentity.learnerId!==this.identity.learnerId||envelope.target.scope!=='LEARNER'||envelope.target.learnerId!==this.identity.learnerId)fail('FORBIDDEN','这条待确认的保存属于另一位学习者，请回到原学习者继续。');
 }
 private async requireOriginalLearner(){
  const session=await this.ports.auth.session();
  if(!session||session.role!=='LEARNER'||session.familyId!==this.identity.familyId||session.learnerId!==this.identity.learnerId)fail('UNAUTHENTICATED','请重新进入原来的学习者，再确认这次保存。');
 }
 private async execute(envelope:PublicCommandEnvelope,confirm=false):Promise<CommandReceipt|null>{
  if(this.state.busy)return null;
  this.update({busy:true,error:'',errorCode:'',recoveryNote:''});
  try{
   this.assertPendingScope(envelope);
   this.store.setItem(this.key,JSON.stringify({...this.pendingIdentity,envelope}));this.update({pending:envelope});
   await this.requireOriginalLearner();
   const lookup=confirm&&this.ports.client.receipt?await this.ports.client.receipt({idempotencyKey:envelope.idempotencyKey,commandKind:envelope.kind}):null;
   // NOT_FOUND alone proves nothing. Only this exact envelope may be delivered again.
   const receipt=lookup?.status==='CONFIRMED'?lookup.receipt:await this.ports.client.command(envelope);
   if(receipt.idempotencyKey!==envelope.idempotencyKey||receipt.kind!==envelope.kind||receipt.commandId!==envelope.commandId)fail('HOST_RECOVERING','回执未匹配原请求，请按原请求继续确认。');
   if(receipt.status==='ADMITTED'){
    this.update({recoveryNote:'原请求已受理，最终回执仍待确认；保留原请求，不另发一次运行。'});return null;
   }
   if(receipt.status==='APPLIED')acknowledgeActivityDraft(this.store,this.identity,envelope,receipt);
   this.store.removeItem(this.key);this.update({pending:null,needsReentry:false});
   if(receipt.status==='REJECTED'){
    if(envelope.kind==='code.requestRun')this.update({recoveryNote:'已确认这条运行请求未执行。原代码和旧运行记录仍保留，可以保存当前编辑、返回目录并继续其他学习。'});
    fail(receipt.errorCode??'INVALID_OPERATION',envelope.kind==='code.requestRun'?'服务端已明确拒绝这条运行请求，未执行代码。':'这次保存没有被应用，请检查当前活动后再试。');
   }
   if(envelope.kind==='code.requestRun')this.update({recoveryNote:'运行请求已确认受理。是否得到结果请看运行状态；确认请求不会再次执行代码。'});
   return receipt;
  }catch(e){
   // The server checks the original receipt before CAS: this named error proves no write under this key.
   if(errorCode(e)==='VERSION_CONFLICT'&&!(e&&typeof e==='object'&&'transport'in e&&e.transport==='RECEIPT_UNKNOWN')){
    try{this.store.removeItem(this.key);this.update({pending:null});}catch{/* Preserve the original pending key if local cleanup failed. */}
   }
   this.reportFailure(e);return null;
  }finally{this.update({busy:false});}
 }
 send=async(kind:CommandKind,payload:unknown,target:unknown,version?:number,binding?:unknown)=>{
  if(this.state.pending||this.state.busy||this.state.recovering||this.state.needsReentry)return null;
  const id=crypto.randomUUID();
  try{const envelope=parseEnvelope({protocolVersion:'rondo.v1',commandId:'cmd-'+id,idempotencyKey:'mvp-'+id,kind,payload,target,...(version?{expectedAttemptVersion:version}:{}),...(binding?{binding}:{})});this.pendingIdentity=this.identity;return await this.execute(envelope);}
  catch(e){this.reportFailure(e);return null;}
 };
 retry=async()=>this.state.pending&&!this.state.busy&&!this.state.recovering?this.execute(this.state.pending,true):null;
 reenterAndRetry=async(passphrase:string):Promise<{reentered:boolean;receipt:CommandReceipt|null}>=>{
  if(this.state.busy||this.state.recovering)return {reentered:false,receipt:null};
  this.update({recovering:true,recoveryError:'',recoveryNote:''});
  try{
   if(this.state.pending)this.assertPendingScope(this.state.pending);
   const guardian=await this.ports.auth.unlockGuardian({passphrase});
   if(guardian.role!=='GUARDIAN'||guardian.familyId!==this.identity.familyId)fail('FORBIDDEN','解锁的家庭与原学习记录不一致，不能确认这条保存。');
   const learner=await this.ports.auth.enterLearner({learnerId:this.identity.learnerId});
   if(learner.role!=='LEARNER'||learner.familyId!==this.identity.familyId||learner.learnerId!==this.identity.learnerId)fail('FORBIDDEN','没有回到原来的学习者，刚才的请求仍保留，尚未重放。');
   await this.requireOriginalLearner();
   this.update({needsReentry:false,error:'',errorCode:''});
   const receipt=this.state.pending?await this.execute(this.state.pending,true):null;
   if(!this.state.pending&&!this.state.error&&!this.state.recoveryNote)this.update({recoveryNote:receipt?'已重新进入，刚才的保存已确认。当前页面的编辑仍保留。':'已重新进入。当前页面的编辑仍保留，可以继续这次探索。'});
   return {reentered:true,receipt};
  }catch(e){this.update({needsReentry:true,recoveryError:errorText(e)});return {reentered:false,receipt:null};}
  finally{this.update({recovering:false});}
 };
}
