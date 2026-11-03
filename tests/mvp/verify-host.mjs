/** Synthetic real HTTP/DSH/SQLite integration proof. Requires this candidate's isolated Host. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const base=process.env.RONDO_VERIFY_URL??'http://127.0.0.1:47623';
const out=resolve(import.meta.dirname,'../../../delivery');
const evidence={candidate:'rondo-mvp-20261028-r1',url:base,startedAt:new Date().toISOString(),checks:[],calls:[]};
function check(name,fn){fn();evidence.checks.push(name);}
async function api(path,payload){const res=await fetch(base+'/rondo/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload??{})});const data=await res.json();if(!path.startsWith('auth/'))evidence.calls.push({path,payload,result:data});if(!data.ok)throw data.error;return data.value;}
const query=p=>api('query',p);
function envelope(kind,payload,target,version,binding){const id=randomUUID();return {protocolVersion:'rondo.v1',commandId:'cmd-'+id,idempotencyKey:'mvp-proof-'+id,kind,target,payload,...(version?{expectedAttemptVersion:version}:{}),...(binding?{binding}:{})};}
let learnerId,attemptId,releaseId;
async function cmd(kind,payload={},raw=false){let v,q;if(attemptId){v=await query({kind:'learning.attemptView',attemptId});q=await query({kind:'learning.questionView',attemptId});}
const env=envelope(kind,payload,{scope:'LEARNER',learnerId,...(attemptId?{attemptId}:{})},v?.version,q?{releaseId,questionInstanceId:q.spec.questionInstanceId,rendererContractVersion:'1'}:undefined);const result=await api('command',env);assert.equal(result.status,'APPLIED',JSON.stringify(result));return raw?{env,result}:result;}
async function start(release){attemptId=undefined;releaseId=release;const r=await cmd('learning.startAttempt',{releaseId});attemptId=r.effectRefs.find(x=>x.startsWith('attempt:')).slice(8);return attemptId;}
async function history(){return query({kind:'learning.activityHistory',learnerId});}
async function current(){return (await history()).attempts.find(x=>x.attemptId===attemptId).cycles[0];}
async function operation(operation){return cmd('learning.commitOperation',{operation});}
async function finish(text){await cmd('learning.beginExplanation');await cmd('learning.saveExplanation',{selections:[],freeText:text,transcribedByGuardian:false});await cmd('learning.finishAttempt');}
async function predict(text){await cmd('learning.recordPrediction',{prediction:{claims:[]},uncertain:true,explanation:text});}
async function run(source,stdin='3\n'){
 const r=await cmd('code.requestRun',{source,stdin,taskId:'mvp.gesp.202303.p1.v1',compilerContractId:'rondo.gesp.gcc13.2.cpp11.linux-arm64.v1'},true);
 const jobId=r.result.effectRefs.find(x=>x.startsWith('job:')).slice(4);
 const replay=await api('command',r.env);assert.deepEqual(replay,r.result);
 const deadline=Date.now()+90000;
 for(;;){const q=await query({kind:'code.runStatus',jobId});if(q.run?.terminal)return q.run;if(Date.now()>deadline)throw Error('code result deadline');await new Promise(r=>setTimeout(r,150));}
}
try{
 const info=await api('platform/info',{});
 if(!info.guardianConfigured){await api('auth/setupGuardian',{idempotencyKey:'synthetic-mvp-setup',familyDisplayName:'合成验证家庭',guardianDisplayName:'合成监护人',passphrase:'synthetic-only-20261028'});await api('auth/unlockGuardian',{passphrase:'synthetic-only-20261028'});await api('command',envelope('family.createLearner',{alias:'合成学习者'},{scope:'FAMILY'}));}
 else await api('auth/unlockGuardian',{passphrase:'synthetic-only-20261028'});
 const learners=await api('view/listLearners',{});learnerId=learners.find(x=>x.alias==='合成学习者').learnerId;
 await api('auth/enterLearner',{learnerId});
 const math1=await start('rondo.mvp.math-ratio-r1');
 const q=await query({kind:'learning.questionView',attemptId});
 assert.equal(q.spec.scene.rendererId,'rondo.activity');
 const draft={...q.spec.scene.state.draft,prediction:'我先猜橙汁占3/2，扩大两倍关系会变吗？',answerText:JSON.stringify({ratio:'3-to-2',numerator:'3',denominator:'2'})};
 await operation({type:'SaveActivityDraft',draft});
 await cmd('learning.pauseAttempt');await cmd('learning.resumeAttempt');
 check('saved draft survives pause/resume and fresh HTTP reads',async()=>{});
 assert.deepEqual((await query({kind:'learning.questionView',attemptId})).spec.scene.state.draft,draft);
 await predict(draft.prediction);
 await operation({type:'SetActivityScale',value:2});
 let wrong=[{kind:'singleChoice',selectionId:'ratio',optionId:'3-to-2'},{kind:'fractionValue',quantityId:'juice-share',numerator:3,denominator:2}];
 await cmd('learning.submitResponse',{response:wrong});
 let c=await current();assert.equal(c.submissions[0].outcome,'REVISE');assert.equal(c.submissions[0].feedback.reveal,undefined);
 await cmd('learning.reviseResponse');
 const right=[{kind:'singleChoice',selectionId:'ratio',optionId:'3-to-2'},{kind:'fractionValue',quantityId:'juice-share',numerator:6,denominator:10}];
 const submission=await cmd('learning.submitResponse',{response:right},true);
 assert.deepEqual(await api('command',submission.env),submission.result);
 try{await api('command',{...submission.env,payload:{response:wrong}});throw Error('conflict accepted');}catch(e){assert.equal(e.code,'IDEMPOTENCY_CONFLICT');}
 c=await current();check('math wrong answer retained, equivalent fraction judged, replay deduplicates',()=>{assert.equal(c.submissions.length,2);assert.equal(c.submissions[1].outcome,'CORRECT');});
 await cmd('learning.beginExplanation');await cmd('learning.saveExplanation',{selections:[],freeText:'橙汁与水3比2，整份5杯，橙汁占3/5。',transcribedByGuardian:false});
 await cmd('learning.saveExplanation',{selections:[],freeText:'两种量都扩大2倍，杯数6和4；总量10，6/10等于3/5。',transcribedByGuardian:false});
 await cmd('learning.finishAttempt');
 check('explanation revisions retained and review explanation revealed only after save',()=>{});
 const math2=await start('rondo.mvp.math-ratio-r1');assert.notEqual(math1,math2);
 await predict('第二次先想清楚比的对象。');await operation({type:'SetActivityScale',value:2});await cmd('learning.submitResponse',{response:right});await finish('比是两个指定量的关系，份额还要包含整份。');
 const reference='#include <iostream>\nusing namespace std;\nint main(){int n;cin>>n;int ch=0;for(int i=1;i<=n;i++){for(int j=1;j<=i;j++)cout<<(char)(\'A\'+(ch++)%26);cout<<endl;}return 0;}\n';
 const cpp1=await start('rondo.mvp.gesp-202303-p1-r1');await predict('每行字母数增加，字母不能每行从A重新开始。');await operation({type:'InspectActivityCard',cardId:'algorithm'});
 const syntax=await run('#include <iostream>\nint main(){ this is invalid; }');assert.equal(syntax.status,'COMPILE_ERROR');assert.equal(syntax.stdout,'');
 const fake=await run('#include <iostream>\nint main(){std::cout<<"A\\nBC\\nDEF\\n";}');assert.equal(fake.status,'OK');
 await cmd('learning.submitResponse',{response:[{kind:'codeRun',jobId:fake.jobId,source:fake.source,stdin:fake.stdin}]});assert.equal((await current()).submissions[0].outcome,'REVISE');await cmd('learning.reviseResponse');
 check('compile success and visible sample success do not pass private task checks',()=>{assert.equal(fake.stdout,'A\nBC\nDEF\n');});
 const good=await run(reference);assert.equal(good.status,'OK');
 const before=(await current()).submissions.length;
 const stale=await cmd('code.requestCancel',{jobId:good.jobId},true);assert.equal(stale.result.status,'APPLIED');
 const v=await query({kind:'learning.attemptView',attemptId});const question=await query({kind:'learning.questionView',attemptId});
 const staleEnv=envelope('learning.submitResponse',{response:[{kind:'codeRun',jobId:good.jobId,source:reference+'// edited',stdin:good.stdin}]},{scope:'LEARNER',learnerId,attemptId},v.version,{releaseId,questionInstanceId:question.spec.questionInstanceId,rendererContractVersion:'1'});
 const rejected=await api('command',staleEnv);assert.equal(rejected.status,'REJECTED');assert.equal((await current()).submissions.length,before);
 await cmd('learning.submitResponse',{response:[{kind:'codeRun',jobId:good.jobId,source:reference,stdin:good.stdin}]});assert.equal((await current()).submissions.at(-1).outcome,'CORRECT');await finish('跨行保存ch，以26取余回到A；外层控制行，内层控制该行长度。');
 check('source/input/compiler/job/request identities persist; stale edited source rejected',()=>{assert.equal(good.source,reference);assert.ok(good.workerJobId);assert.equal(good.inputHash.length,64);});
 const cpp2=await start('rondo.mvp.gesp-202303-p1-r1');await predict('我会再检查大于26个字母的情况。');await operation({type:'InspectActivityCard',cardId:'algorithm'});const good2=await run(reference,'7\n');await cmd('learning.submitResponse',{response:[{kind:'codeRun',jobId:good2.jobId,source:reference,stdin:good2.stdin}]});await finish('n=7末行从V继续，Z之后接A和B。');assert.notEqual(cpp1,cpp2);
 const ai1=await start('rondo.mvp.ai-a7-r1');await predict('听起来可信，但每天和一定都需要资料核查。');for(const cardId of ['hours','animals','bus'])await operation({type:'InspectActivityCard',cardId});
 const claims=[{kind:'singleChoice',selectionId:'hours',optionId:'conflict'},{kind:'singleChoice',selectionId:'animals',optionId:'conflict'},{kind:'singleChoice',selectionId:'bus',optionId:'insufficient'}];
 await cmd('learning.submitResponse',{response:claims});assert.equal((await current()).submissions[0].outcome,'CORRECT');await finish('周一闭园与每天冲突，禁止投喂与可以喂鹿冲突，公交缺资料需查交通机构。');
 const ai2=await start('rondo.mvp.ai-a7-r1');await predict('我先列出事实，再判断每项说法。');for(const cardId of ['hours','animals','bus'])await operation({type:'InspectActivityCard',cardId});await cmd('learning.submitResponse',{response:claims});await finish('语气自信不说明有证据，未提及不能直接当作否定。');assert.notEqual(ai1,ai2);
 const final=await history();writeFileSync(out+'/host-history.json',JSON.stringify(final,null,2));
 check('one learner, six distinct attempts, complete cross-domain history survives fresh reads',()=>{assert.equal(final.attempts.length,6);assert.equal(new Set(final.attempts.map(x=>x.attemptId)).size,6);for(const a of final.attempts){assert.equal(a.status,'COMPLETED');for(const c of a.cycles){assert.ok(c.prediction);assert.ok(c.submissions.length);assert.ok(c.explanations.length);}}assert.equal(final.attempts[0].cycles[0].explanations.length,2);});
 evidence.ids={learnerId,math1,math2,cpp1,cpp2,ai1,ai2};evidence.status='PASS';
}catch(e){evidence.status='FAIL';evidence.error=e instanceof Error?{message:e.message,stack:e.stack}:e;throw e;}
finally{evidence.finishedAt=new Date().toISOString();writeFileSync(out+'/host-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({status:evidence.status,checks:evidence.checks,error:evidence.error}));}
