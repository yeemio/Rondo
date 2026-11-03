import {activityDraftSchema,type ActivityState} from '../../../../modules/contracts/public/activity';
import {parseEnvelope,type PublicCommandEnvelope} from '../../../../modules/contracts/public/envelope';
import type {CommandReceipt} from '../../../../modules/contracts/public/receipts';

export type ActivityDraft = ActivityState['draft'];
export interface DraftStore {getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void;}
export interface DraftIdentity {familyId:string;learnerId:string;attemptId:string;releaseId:string;}
export interface DraftBasis extends DraftIdentity {questionInstanceId:string;version:number;}
interface DraftRecord {familyId:string;learnerId:string;envelope:PublicCommandEnvelope;baseDraft?:ActivityDraft;retainedDraft?:ActivityDraft;}
export interface ActivityDraftSnapshot {draft:ActivityDraft|null;dirty:boolean;locallyStored:boolean;retainedDraft:ActivityDraft|null;notice:string;storageError:string;}
export const activityDraftKey=(learnerId:string)=>'rondo.draft.'+learnerId;
export const sameActivityDraft=(a:ActivityDraft|null|undefined,b:ActivityDraft|null|undefined)=>!!a&&!!b&&JSON.stringify(a)===JSON.stringify(b);
const saveDraft=(envelope:PublicCommandEnvelope):ActivityDraft|null=>{
 if(envelope.kind!=='learning.commitOperation')return null;
 const operation=(envelope.payload as {operation?:{type?:string;draft?:unknown}}).operation;
 return operation?.type==='SaveActivityDraft'?activityDraftSchema.parse(operation.draft):null;
};
function readRecord(store:DraftStore,learnerId:string):DraftRecord|null{
 const raw=store.getItem(activityDraftKey(learnerId));if(!raw)return null;
 const value=JSON.parse(raw) as DraftRecord;
 // Legacy command drafts stay readable by their original consumer, never silently replaced.
 if(!value.envelope)throw Error('本机还保留旧的待确认编辑。');
 const envelope=parseEnvelope(value.envelope);if(!saveDraft(envelope))throw Error('本机还保留其他活动的待确认编辑。');
 return {...value,envelope,baseDraft:value.baseDraft?activityDraftSchema.parse(value.baseDraft):undefined,
  retainedDraft:value.retainedDraft?activityDraftSchema.parse(value.retainedDraft):undefined};
}
function belongs(record:DraftRecord,identity:DraftIdentity):boolean{
 return record.familyId===identity.familyId&&record.learnerId===identity.learnerId&&record.envelope.target.scope==='LEARNER'&&
  record.envelope.target.learnerId===identity.learnerId&&record.envelope.target.attemptId===identity.attemptId&&record.envelope.binding?.releaseId===identity.releaseId;
}

/** A received APPLIED snapshot may be older than the editor. Rebase that newer local draft, never erase it. */
export function acknowledgeActivityDraft(store:DraftStore,identity:{familyId:string;learnerId:string},envelope:PublicCommandEnvelope,receipt:CommandReceipt):void{
 const sent=saveDraft(envelope);if(!sent||receipt.status!=='APPLIED'||receipt.attemptVersion===undefined)return;
 let record:DraftRecord|null;try{record=readRecord(store,identity.learnerId);}catch{return;}if(!record)return;
 if(record.familyId!==identity.familyId||record.learnerId!==identity.learnerId||envelope.target.scope!=='LEARNER'||
  envelope.target.learnerId!==identity.learnerId||record.envelope.target.scope!=='LEARNER'||record.envelope.target.learnerId!==identity.learnerId||
  record.envelope.target.attemptId!==envelope.target.attemptId||
  record.envelope.binding?.questionInstanceId!==envelope.binding?.questionInstanceId||
  record.envelope.expectedAttemptVersion!==envelope.expectedAttemptVersion)return;
 try{
  if(sameActivityDraft(saveDraft(record.envelope),sent)&&!record.retainedDraft){store.removeItem(activityDraftKey(identity.learnerId));return;}
  store.setItem(activityDraftKey(identity.learnerId),JSON.stringify({...record,baseDraft:sent,
   envelope:{...record.envelope,expectedAttemptVersion:receipt.attemptVersion}}));
 }catch{/* The committed receipt stays authoritative; the editor separately reports local storage failures. */}
}

/** Local editing only. This store never submits a command or turns a draft into a learning fact. */
export class ActivityDrafts {
 private state:ActivityDraftSnapshot={draft:null,dirty:false,locallyStored:false,retainedDraft:null,notice:'',storageError:''};
 private basis:DraftBasis|null=null;
 private base:ActivityDraft|null=null;
 private listeners=new Set<(state:ActivityDraftSnapshot)=>void>();
 constructor(private identity:DraftIdentity,private store:DraftStore){}
 getSnapshot=()=>this.state;
 subscribe=(listener:(state:ActivityDraftSnapshot)=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private emit(){this.state={...this.state};for(const listener of this.listeners)listener(this.state);}
 note=(notice:string)=>{this.state.notice=notice;this.emit();};
 private persist(){
  if(!this.basis||!this.state.draft)return;
  try{
   const existing=readRecord(this.store,this.identity.learnerId);
   if(existing&&!belongs(existing,this.identity))throw Error('本机另一个活动或家庭的旧编辑仍保留，未覆盖它。');
   if(existing&&(existing.envelope.expectedAttemptVersion??0)>this.basis.version)throw Error('本机已有较新版本的编辑，未覆盖它。');
   if(!this.state.dirty&&!this.state.retainedDraft){if(existing)this.store.removeItem(activityDraftKey(this.identity.learnerId));this.state.locallyStored=true;this.state.storageError='';return;}
   const id=crypto.randomUUID(),b=this.basis;
   const envelope=parseEnvelope({protocolVersion:'rondo.v1',commandId:'draft-'+id,idempotencyKey:'draft-'+id,
    kind:'learning.commitOperation',target:{scope:'LEARNER',learnerId:b.learnerId,attemptId:b.attemptId},expectedAttemptVersion:b.version,
    binding:{releaseId:b.releaseId,questionInstanceId:b.questionInstanceId,rendererContractVersion:'1'},
    payload:{operation:{type:'SaveActivityDraft',draft:this.state.draft}}});
   this.store.setItem(activityDraftKey(b.learnerId),JSON.stringify({familyId:b.familyId,learnerId:b.learnerId,envelope,
    baseDraft:this.base,...(this.state.retainedDraft?{retainedDraft:this.state.retainedDraft}:{})}));
   this.state.locallyStored=true;this.state.storageError='';
  }catch{this.state.locallyStored=false;this.state.storageError='当前编辑尚未保留到本机，请先保存再刷新或关闭；页面会保护尚未保存的编辑。';}
 }
 /** Server content wins a conflict; the old text remains separately copyable and is never replayed. */
 readServer(basis:DraftBasis,server:ActivityDraft,ownSaved?:ActivityDraft):boolean{
  if(basis.familyId!==this.identity.familyId||basis.learnerId!==this.identity.learnerId||basis.attemptId!==this.identity.attemptId||basis.releaseId!==this.identity.releaseId)throw Error('编辑记录不属于当前学习活动。');
  if(this.basis&&basis.version<this.basis.version)return false;
  const authoritative=activityDraftSchema.parse(server);
  let recoveredAcknowledgement=false;
  if(this.state.draft)try{const record=readRecord(this.store,this.identity.learnerId);recoveredAcknowledgement=!!record&&belongs(record,this.identity)&&
   record.envelope.binding?.questionInstanceId===basis.questionInstanceId&&(record.envelope.expectedAttemptVersion??0)<=basis.version&&sameActivityDraft(record.baseDraft,authoritative);
  }catch{/* An unreadable local record cannot override server content. */}
  if(!this.state.draft){
   this.state.draft=authoritative;
   try{
    const record=readRecord(this.store,this.identity.learnerId);
    if(record&&belongs(record,this.identity)){
     const local=saveDraft(record.envelope)!;this.state.retainedDraft=record.retainedDraft??null;
     if(record.envelope.binding?.questionInstanceId!==basis.questionInstanceId){
      this.state.retainedDraft=local;this.state.notice='已进入新的学习任务，旧任务的本机编辑单独保留，可复制核对。';
     }else if(!sameActivityDraft(local,authoritative)){
      if(record.envelope.expectedAttemptVersion===basis.version||sameActivityDraft(record.baseDraft,authoritative)){
       this.state.draft=local;this.state.dirty=true;this.state.notice='已恢复本机未保存的编辑，尚未作为学习记录保存。';
      }else{this.state.retainedDraft=local;this.state.notice='学习记录已有更新。当前显示服务端版本，较早的本机编辑单独保留在下方，可复制核对。';}
     }
    }
   }catch{this.state.storageError='本机旧编辑暂时无法读取，已保留原记录；当前显示服务端版本。';}
  }else if(this.basis?.questionInstanceId!==basis.questionInstanceId){
   if(this.state.dirty){this.state.retainedDraft=this.state.draft;this.state.notice='已进入新的学习任务，上个任务的未保存编辑单独保留，可复制核对。';}
   this.state.draft=authoritative;this.state.dirty=false;
  }else if(sameActivityDraft(this.state.draft,authoritative))this.state.dirty=false;
  else if((ownSaved&&sameActivityDraft(ownSaved,authoritative))||sameActivityDraft(this.base,authoritative)||recoveredAcknowledgement){
   this.state.dirty=!sameActivityDraft(this.state.draft,authoritative);
  }else if(this.state.dirty){
   this.state.retainedDraft=this.state.draft;this.state.draft=authoritative;this.state.dirty=false;
   this.state.notice='学习记录已有更新。当前显示服务端版本，刚才未保存的编辑仍单独保留，可复制核对。';
  }else this.state.draft=authoritative;
  this.basis=basis;this.base=authoritative;this.persist();this.emit();
  return !ownSaved||sameActivityDraft(ownSaved,authoritative);
 }
 edit=(key:keyof ActivityDraft,value:string|boolean)=>{
  if(!this.state.draft)return;this.state.draft={...this.state.draft,[key]:value};
  this.state.dirty=!sameActivityDraft(this.state.draft,this.base);this.state.notice='';this.persist();this.emit();
 };
 discardRetained=()=>{this.state.retainedDraft=null;this.state.notice='';this.persist();this.emit();};
}

export interface DraftLeaveState {dirty:boolean;locallyStored:boolean;pending:boolean;pendingRun?:boolean;busy:boolean;needsReentry:boolean;active:boolean;}
/** Internal navigation uses one save, then checks the live state again before allowing an unmount. */
export async function leaveActivityEditor(input:{state:()=>DraftLeaveState;save:()=>Promise<CommandReceipt|null>;confirmPendingRun?:()=>Promise<void>;notice:(message:string)=>void}):Promise<boolean>{
 let state=input.state();
 // Resolve the original delivery before saving or navigating. Never drop a pending key locally.
 if(state.pendingRun&&!state.busy&&!state.needsReentry&&input.confirmPendingRun){
  await input.confirmPendingRun();state=input.state();
 }
 if(state.busy||state.pending||state.needsReentry){input.notice(state.pendingRun?'运行请求仍待确认，原代码和编辑保留在这里；请按原请求确认，不要另发一次运行。':'刚才的保存还没有确认，请先确认保存；当前编辑仍保留在这里。');return false;}
 if(!state.dirty)return true;
 if(!state.active){if(state.locallyStored)return true;input.notice('这次活动已停止编辑，当前草稿尚未保留到本机，请先保留原文。');return false;}
 const receipt=await input.save(),after=input.state();
 if(receipt?.status!=='APPLIED'||after.dirty||after.pending||after.busy||after.needsReentry){
  input.notice('当前编辑尚未全部确认保存，页面保持打开；可以继续编辑或确认刚才的保存。');return false;
 }
 return true;
}

export function protectActivityUnload(event:Pick<BeforeUnloadEvent,'preventDefault'|'returnValue'>,state:{dirty:boolean;locallyStored:boolean;pending:boolean;busy:boolean}):boolean{
 if((state.dirty&&!state.locallyStored)||state.pending||state.busy){event.preventDefault();event.returnValue='';return true;}return false;
}
