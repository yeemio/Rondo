import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const base='http://127.0.0.1:47623',out=new URL('../../../delivery/',import.meta.url);
const report={startedAt:new Date().toISOString(),checks:[],calls:[]};
async function api(path,payload={}){const r=await fetch(base+'/rondo/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!path.startsWith('auth/'))report.calls.push({path,payload,result:d});if(!d.ok)throw d.error;return d.value;}
const env=(kind,payload,target,extra={})=>{const id=randomUUID();return {protocolVersion:'rondo.v1',commandId:id,idempotencyKey:'boundary-'+id,kind,payload,target,...extra};};
let learnerId,attemptId,releaseId='rondo.mvp.gesp-202303-p1-r1';
async function cmd(kind,payload,extra={}){const v=attemptId?await api('query',{kind:'learning.attemptView',attemptId}):null;const q=attemptId?await api('query',{kind:'learning.questionView',attemptId}):null;const e=env(kind,payload,{scope:'LEARNER',learnerId,...(attemptId?{attemptId}:{})},{...(v?{expectedAttemptVersion:v.version,binding:{releaseId,questionInstanceId:q.spec.questionInstanceId,rendererContractVersion:'1'}}:{}),...extra});return {envelope:e,receipt:await api('command',e)};}
try{
 await api('auth/unlockGuardian',{passphrase:'synthetic-only-20261028'});
 const created=await api('command',env('family.createLearner',{alias:'合成接线边界探针'},{scope:'FAMILY'}));learnerId=created.effectRefs.find(x=>x.startsWith('learner:')).slice(8);
 await api('auth/enterLearner',{learnerId});
 const start=await cmd('learning.startAttempt',{releaseId});attemptId=start.receipt.effectRefs.find(x=>x.startsWith('attempt:')).slice(8);
 await cmd('learning.recordPrediction',{prediction:{claims:[]},uncertain:true,explanation:'这个程序故意不停运行，用于验证停止接线。'});
 const payload={source:'#include <unistd.h>\nint main(){sleep(100);}',stdin:'',taskId:'mvp.gesp.202303.p1.v1',compilerContractId:'rondo.gesp.gcc13.2.cpp11.linux-arm64.v1'};
 const bad=await cmd('code.requestRun',payload,{binding:{releaseId,questionInstanceId:'foreign-question',rendererContractVersion:'1'}});assert.equal(bad.receipt.status,'REJECTED');
 const unicode=await cmd('code.requestRun',{...payload,source:'//'+ '中'.repeat(11000)});assert.equal(unicode.receipt.status,'REJECTED');assert.equal(unicode.receipt.errorCode,'INVALID_OPERATION');
 const admitted=await cmd('code.requestRun',payload);assert.equal(admitted.receipt.status,'APPLIED');const jobId=admitted.receipt.effectRefs.find(x=>x.startsWith('job:')).slice(4);
 assert.deepEqual(await api('command',admitted.envelope),admitted.receipt);
 try{await api('command',{...admitted.envelope,payload:{...payload,stdin:'changed'}});throw Error('conflict accepted');}catch(e){assert.equal(e.code,'IDEMPOTENCY_CONFLICT');}
 let run;const deadline=Date.now()+30000;
 for(;;){const q=await api('query',{kind:'code.runStatus',jobId});run=q.run;if(run.status==='RUNNING')break;if(run.terminal)throw Error('job ended before RUNNING: '+run.status);if(Date.now()>deadline)throw Error('not RUNNING');await new Promise(r=>setTimeout(r,60));}
 const cancelled=await cmd('code.requestCancel',{jobId});assert.equal(cancelled.receipt.status,'APPLIED');
 for(;;){const q=await api('query',{kind:'code.runStatus',jobId});run=q.run;if(run.terminal)break;if(Date.now()>deadline)throw Error('cancel deadline');await new Promise(r=>setTimeout(r,60));}
 assert.equal(run.status,'CANCELLED');
 report.checks.push('mismatched question rejected before execution','UTF-8 byte cap rejects multibyte overflow','same request reuses one job; changed input conflicts','real RUNNING worker cancels to confirmed CANCELLED');
 await cmd('learning.endWithoutCompleting',{confirmAbandon:true});
 const main=JSON.parse(readFileSync(new URL('host-verification.json',out),'utf8')).ids.learnerId;
 await api('auth/unlockGuardian',{passphrase:'synthetic-only-20261028'});await api('auth/enterLearner',{learnerId:main});
 try{await api('query',{kind:'code.runStatus',jobId});throw Error('foreign job visible');}catch(e){assert.equal(e.code,'FORBIDDEN');}
 try{await api('query',{kind:'learning.activityHistory',learnerId});throw Error('foreign history visible');}catch(e){assert.equal(e.code,'FORBIDDEN');}
 report.checks.push('cross-learner code job and activity history denied');report.ids={learnerId,attemptId,jobId};report.status='PASS';
}catch(e){report.status='FAIL';report.error=e instanceof Error?{message:e.message,stack:e.stack}:e;throw e;}
finally{report.finishedAt=new Date().toISOString();writeFileSync(new URL('code-boundary-verification.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:report.checks,error:report.error}));}
