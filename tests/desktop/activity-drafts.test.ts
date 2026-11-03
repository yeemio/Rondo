import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ActivityDrafts,activityDraftKey,acknowledgeActivityDraft,leaveActivityEditor,protectActivityUnload,type ActivityDraft,type DraftBasis,type DraftLeaveState} from '../../apps/web/src/studio/activity-drafts';
import {SessionCommands} from '../../apps/web/src/studio/session-recovery';
import {parseEnvelope,type PublicCommandEnvelope} from '../../modules/contracts/public/envelope';
import type {CommandReceipt} from '../../modules/contracts/public/receipts';
import type {LocalAuthPort} from '../../modules/contracts/public/auth';

const identity={familyId:'family-draft',learnerId:'learner-draft',attemptId:'attempt-draft',releaseId:'release-draft'};
const basis:DraftBasis={...identity,questionInstanceId:'question-draft',version:1};
const initial:ActivityDraft={prediction:'',uncertain:false,answerText:'',explanation:'',source:'int main() {}',stdin:''};
function storage(){const values=new Map<string,string>();return{values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
function applied(envelope:PublicCommandEnvelope,version=2):CommandReceipt{return{protocolVersion:'rondo.v1',commandId:envelope.commandId,idempotencyKey:envelope.idempotencyKey,kind:envelope.kind,status:'APPLIED',attemptVersion:version,changedKinds:['learning.questionView'],effectRefs:[]};}
const auth={session:async()=>({role:'LEARNER',familyId:identity.familyId,learnerId:identity.learnerId})} as unknown as LocalAuthPort;
function fromStore(store:ReturnType<typeof storage>){return JSON.parse(store.getItem(activityDraftKey(identity.learnerId))!) as {envelope:PublicCommandEnvelope;baseDraft:ActivityDraft;retainedDraft?:ActivityDraft};}

test('drafts: refresh restores exact text/code as an unsent draft using the existing cleanup-compatible key',()=>{
 const store=storage(),editor=new ActivityDrafts(identity,store);editor.readServer(basis,initial);
 editor.edit('prediction','  我猜这里会保持。🙂  ');editor.edit('source','#include <iostream>\nint main(){std::cout << "想法";}');editor.edit('stdin','3\n');
 const before=editor.getSnapshot();assert.equal(before.dirty,true);assert.equal(before.locallyStored,true);
 const envelope=parseEnvelope(fromStore(store).envelope);assert.equal(envelope.kind,'learning.commitOperation');assert.ok(envelope.target.scope==='LEARNER');assert.equal(envelope.target.attemptId,identity.attemptId);assert.equal(envelope.expectedAttemptVersion,1);
 const refreshed=new ActivityDrafts(identity,store);refreshed.readServer(basis,initial);
 assert.deepEqual(refreshed.getSnapshot().draft,before.draft);assert.equal(refreshed.getSnapshot().dirty,true);assert.match(refreshed.getSnapshot().notice,/尚未/);
 const advanced=new ActivityDrafts(identity,store);advanced.readServer({...basis,version:4},initial);
 assert.deepEqual(advanced.getSnapshot().draft,before.draft);assert.equal(fromStore(store).envelope.expectedAttemptVersion,4);
});

test('drafts: newer server content wins; older local text remains separately retained through refresh and new edits',()=>{
 const store=storage(),editor=new ActivityDrafts(identity,store);editor.readServer(basis,initial);editor.edit('explanation','本机旧想法');
 const newer={...initial,explanation:'服务端较新想法'};const refreshed=new ActivityDrafts(identity,store);
 refreshed.readServer({...basis,version:3},newer);assert.deepEqual(refreshed.getSnapshot().draft,newer);assert.equal(refreshed.getSnapshot().dirty,false);
 assert.equal(refreshed.getSnapshot().retainedDraft!.explanation,'本机旧想法');assert.match(refreshed.getSnapshot().notice,/服务端/);
 refreshed.edit('prediction','在新版基础上新增');
 const again=new ActivityDrafts(identity,store);again.readServer({...basis,version:3},newer);
 assert.equal(again.getSnapshot().draft!.prediction,'在新版基础上新增');assert.equal(again.getSnapshot().retainedDraft!.explanation,'本机旧想法');
 again.discardRetained();assert.equal(again.getSnapshot().retainedDraft,null);assert.equal(again.getSnapshot().dirty,true);
});

test('drafts: an old APPLIED snapshot cannot clear edits entered while that save was in flight',async()=>{
 const store=storage(),editor=new ActivityDrafts(identity,store);editor.readServer(basis,initial);editor.edit('source','first snapshot');
 const sent={...editor.getSnapshot().draft!};let finish!:(receipt:CommandReceipt)=>void;let envelope!:PublicCommandEnvelope;let begin!:()=>void;const started=new Promise<void>(resolve=>{begin=resolve;});
 const controller=new SessionCommands({auth,client:{command:async value=>{envelope=value;begin();return new Promise<CommandReceipt>(resolve=>{finish=resolve;});}}},identity,store);
 const pending=controller.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:sent}},
  {scope:'LEARNER',learnerId:identity.learnerId,attemptId:identity.attemptId},1,{releaseId:identity.releaseId,questionInstanceId:basis.questionInstanceId,rendererContractVersion:'1'});
 await started;editor.edit('source','newer text while saving');finish(applied(envelope));
 assert.equal((await pending)?.status,'APPLIED');editor.readServer({...basis,version:2},sent,sent);
 assert.equal(editor.getSnapshot().draft!.source,'newer text while saving');assert.equal(editor.getSnapshot().dirty,true);
 const refreshed=new ActivityDrafts(identity,store);refreshed.readServer({...basis,version:2},sent);
 assert.equal(refreshed.getSnapshot().draft!.source,'newer text while saving');assert.equal(refreshed.getSnapshot().retainedDraft,null);
});

test('drafts: committed-but-lost response keeps original key; recovery rebases newer edits without a second write',async()=>{
 const store=storage(),editor=new ActivityDrafts(identity,store);editor.readServer(basis,initial);editor.edit('prediction','original save');
 const sent={...editor.getSnapshot().draft!};const requests:PublicCommandEnvelope[]=[];let committed:CommandReceipt|null=null,writes=0;
 const controller=new SessionCommands({auth,client:{command:async envelope=>{requests.push(envelope);if(committed)return committed;writes++;committed=applied(envelope);throw Object.assign(Error('reply lost'),{transport:'RECEIPT_UNKNOWN'});}}},identity,store);
 await controller.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:sent}},
  {scope:'LEARNER',learnerId:identity.learnerId,attemptId:identity.attemptId},1,{releaseId:identity.releaseId,questionInstanceId:basis.questionInstanceId,rendererContractVersion:'1'});
 editor.edit('prediction','newer local wording');assert.ok(controller.getSnapshot().pending);
 assert.equal((await controller.retry())?.status,'APPLIED');assert.deepEqual(requests[0],requests[1]);assert.equal(writes,1);
 editor.readServer({...basis,version:2},sent);assert.equal(editor.getSnapshot().draft!.prediction,'newer local wording');assert.equal(editor.getSnapshot().dirty,true);
 const afterRefresh=new ActivityDrafts(identity,store);afterRefresh.readServer({...basis,version:2},sent);
 assert.equal(afterRefresh.getSnapshot().draft!.prediction,'newer local wording');assert.equal(afterRefresh.getSnapshot().retainedDraft,null);
});

test('drafts: normal internal leaving saves once; failures, unknown receipts and later edits keep the page mounted',async()=>{
 let state:DraftLeaveState={dirty:true,locallyStored:true,pending:false,busy:false,needsReentry:false,active:true},saves=0;const notices:string[]=[];
 const receipt={status:'APPLIED'} as CommandReceipt;
 assert.equal(await leaveActivityEditor({state:()=>state,notice:n=>notices.push(n),save:async()=>{saves++;state={...state,dirty:false};return receipt;}}),true);assert.equal(saves,1);
 state={...state,dirty:true};assert.equal(await leaveActivityEditor({state:()=>state,notice:n=>notices.push(n),save:async()=>null}),false);
 state={...state,pending:true};assert.equal(await leaveActivityEditor({state:()=>state,notice:n=>notices.push(n),save:async()=>{throw Error('must not resend');}}),false);
 state={...state,pending:false};assert.equal(await leaveActivityEditor({state:()=>state,notice:n=>notices.push(n),save:async()=>receipt}),false);
 state={...state,dirty:false,busy:true};assert.equal(await leaveActivityEditor({state:()=>state,notice:n=>notices.push(n),save:async()=>receipt}),false);
 assert.ok(notices.every(n=>!n.includes('保存成功')));
});

test('drafts: quota/storage failure keeps edits in memory and protects refresh until a real save/readback succeeds',async()=>{
 const store={getItem:()=>null,setItem:()=>{throw Error('quota');},removeItem:()=>{}};const editor=new ActivityDrafts(identity,store);editor.readServer(basis,initial);editor.edit('explanation','还没有留到本机');
 assert.equal(editor.getSnapshot().dirty,true);assert.equal(editor.getSnapshot().locallyStored,false);assert.equal(editor.getSnapshot().draft!.explanation,'还没有留到本机');
 let prevented=0;const event={preventDefault:()=>{prevented++;},returnValue:'unchanged'};
 assert.equal(protectActivityUnload(event,{...editor.getSnapshot(),pending:false,busy:false}),true);assert.equal(prevented,1);assert.equal(event.returnValue,'');
 const saved={...editor.getSnapshot().draft!};editor.readServer({...basis,version:2},saved,saved);assert.equal(editor.getSnapshot().dirty,false);
 assert.equal(protectActivityUnload(event,{...editor.getSnapshot(),pending:false,busy:false}),false);
});

test('drafts: other-family/attempt data and malformed old drafts are preserved, never restored or overwritten',()=>{
 const store=storage(),first=new ActivityDrafts(identity,store);first.readServer(basis,initial);first.edit('source','protected original');const encoded=store.getItem(activityDraftKey(identity.learnerId));
 for(const changed of [{...identity,familyId:'family-other'},{...identity,attemptId:'attempt-other'}]){
  const next=new ActivityDrafts(changed,store);next.readServer({...basis,...changed},initial);assert.deepEqual(next.getSnapshot().draft,initial);
  next.edit('source','must not replace protected original');assert.equal(next.getSnapshot().locallyStored,false);assert.equal(store.getItem(activityDraftKey(identity.learnerId)),encoded);
 }
 store.setItem(activityDraftKey(identity.learnerId),'{malformed');const unreadable=new ActivityDrafts(identity,store);unreadable.readServer(basis,initial);unreadable.edit('prediction','memory survives');
 assert.equal(store.getItem(activityDraftKey(identity.learnerId)),'{malformed');assert.equal(unreadable.getSnapshot().draft!.prediction,'memory survives');assert.equal(unreadable.getSnapshot().locallyStored,false);
});

test('drafts: new question and backwards readback cannot apply old edits to another task or erase newer state',()=>{
 const store=storage(),editor=new ActivityDrafts(identity,store);editor.readServer(basis,initial);editor.edit('prediction','old question wording');
 const refreshed=new ActivityDrafts(identity,store);refreshed.readServer({...basis,questionInstanceId:'question-new',version:2},initial);
 assert.deepEqual(refreshed.getSnapshot().draft,initial);assert.equal(refreshed.getSnapshot().retainedDraft!.prediction,'old question wording');
 refreshed.edit('prediction','new question wording');const current=refreshed.getSnapshot();
 assert.equal(refreshed.readServer(basis,{...initial,prediction:'stale result'}),false);assert.deepEqual(refreshed.getSnapshot(),current);
});

test('drafts: definite VERSION_CONFLICT releases only the rejected pending key and keeps local wording for conflict review',async()=>{
 const store=storage(),editor=new ActivityDrafts(identity,store);editor.readServer(basis,initial);editor.edit('prediction','retain after rejection');
 const controller=new SessionCommands({auth,client:{command:async()=>{throw Object.assign(Error('version changed'),{code:'VERSION_CONFLICT'});}}},identity,store);
 await controller.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:editor.getSnapshot().draft}},
  {scope:'LEARNER',learnerId:identity.learnerId,attemptId:identity.attemptId},1,{releaseId:identity.releaseId,questionInstanceId:basis.questionInstanceId,rendererContractVersion:'1'});
 assert.equal(controller.getSnapshot().pending,null);assert.equal(controller.getSnapshot().errorCode,'VERSION_CONFLICT');assert.ok(store.getItem(activityDraftKey(identity.learnerId)));
 editor.readServer({...basis,version:3},{...initial,prediction:'server newer'});assert.equal(editor.getSnapshot().draft!.prediction,'server newer');assert.equal(editor.getSnapshot().retainedDraft!.prediction,'retain after rejection');
 const uncertain=new SessionCommands({auth,client:{command:async()=>{throw Object.assign(Error('unknown delivery'),{code:'VERSION_CONFLICT',transport:'RECEIPT_UNKNOWN'});}}},identity,store);
 await uncertain.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:initial}},
  {scope:'LEARNER',learnerId:identity.learnerId,attemptId:identity.attemptId},3,{releaseId:identity.releaseId,questionInstanceId:basis.questionInstanceId,rendererContractVersion:'1'});
 assert.ok(uncertain.getSnapshot().pending);
});

test('drafts: mismatched receipts stay pending, and a read-only/local draft is never mislabeled as a committed fact',async()=>{
 const store=storage(),controller=new SessionCommands({auth,client:{command:async envelope=>({...applied(envelope),idempotencyKey:'wrong-key'})}},identity,store);
 await controller.send('learning.commitOperation',{operation:{type:'SaveActivityDraft',draft:initial}},
  {scope:'LEARNER',learnerId:identity.learnerId,attemptId:identity.attemptId},1,{releaseId:identity.releaseId,questionInstanceId:basis.questionInstanceId,rendererContractVersion:'1'});
 assert.ok(controller.getSnapshot().pending);assert.equal(controller.getSnapshot().errorCode,'HOST_RECOVERING');
 let saves=0;assert.equal(await leaveActivityEditor({state:()=>({dirty:true,locallyStored:true,pending:false,busy:false,needsReentry:false,active:false}),notice:()=>{},save:async()=>{saves++;return null;}}),true);assert.equal(saves,0);
 assert.equal(protectActivityUnload({preventDefault(){},returnValue:''},{dirty:true,locallyStored:true,pending:false,busy:false}),false);
 assert.equal(protectActivityUnload({preventDefault(){},returnValue:''},{dirty:false,locallyStored:true,pending:true,busy:false}),true);
});
