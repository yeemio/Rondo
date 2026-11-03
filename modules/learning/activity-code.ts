/** Versioned integration of the accepted b2 worker. Durable facts stay in learningEvent. */
import { createHash } from 'node:crypto';
import type { CodeSnapshot } from '../contracts/public/activity';
import type { RunCompiler } from './compiler-lifecycle';
export const hashText=(text:string)=>createHash('sha256').update(text).digest('hex');
export function triangle(n:number):string { let k=0; return Array.from({length:n},(_,i)=>Array.from({length:i+1},()=>String.fromCharCode(65+k++%26)).join('')).join('\n')+'\n'; }
export function normalizeOutput(text:string):string { return text.replace(/\r\n/g,'\n').replace(/\n$/,''); }
export const UNCONFIRMED_CODE_MESSAGE='执行结果未确认，本次未判分。原代码、输入和运行记录仍保留；请保存编辑后继续其他学习。';
export interface CodeFailure {
 stage:'VISIBLE'|'PRIVATE_CHECK'|'LAUNCH';
 operation:'SUBMIT'|'READ'|'CANCEL'|'RESULT'|'PERSIST'|'PREPARE';
 category:'UNKNOWN'|'WORKER_UNKNOWN'|'WORKER_UNAVAILABLE'|'WORKER_INTERNAL_ERROR'|'MISSING_JOB'|'PERSISTENCE_FAILED';
 workerJobId:string|null;
 /** Last observed worker phase only; no inferred infrastructure root cause. */
 workerPhase?:'queue'|'compile'|'run';
 checkIndex?:number;
}
export interface StoredCodeRun {
 run:CodeSnapshot;
 privatePassed:boolean|null;
 privateChecks?:Array<{workerJobId:string;sourceHash:string;inputHash:string;status:string}>;
 /** Optional server-only evidence; older event payloads remain readable unchanged. */
 diagnostics?:CodeFailure[];
}
const safeId=(value:string|null)=>value&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)?value:null;
/** Fixed fields only. Never log error text, source, stdin, outputs or expected answers. */
export function reportCodeFailure(run:Pick<CodeSnapshot,'jobId'|'instanceId'>,failure:CodeFailure):void {
 console.error(JSON.stringify({event:'rondo.code.failure',jobId:safeId(run.jobId),instanceId:safeId(run.instanceId),...failure,workerJobId:safeId(failure.workerJobId)}));
}
const unconfirmed=(state:string)=>['UNKNOWN','CAPABILITY_UNAVAILABLE','INTERNAL_ERROR'].includes(state);
const categoryFor=(state:string):CodeFailure['category']=>state==='CAPABILITY_UNAVAILABLE'?'WORKER_UNAVAILABLE':state==='INTERNAL_ERROR'?'WORKER_INTERNAL_ERROR':'WORKER_UNKNOWN';
export async function executeActivityCode(compiler:RunCompiler, stored:StoredCodeRun, privateInputs:number[]|Array<{stdin:string;stdout:string;mode:'exact'|'tokens';label:string}>, persist:(run:StoredCodeRun)=>Promise<void>, cancelled:()=>boolean):Promise<void>{
 const run=stored.run;
 let location:Omit<CodeFailure,'category'>={stage:'VISIBLE',operation:'SUBMIT',workerJobId:null};
 let failureCategory:CodeFailure['category']='UNKNOWN';
 let persistenceFailed=false;
 const diagnose=(failure:CodeFailure)=>{
  const safe={...failure,workerJobId:safeId(failure.workerJobId)};
  const diagnostics=stored.diagnostics??=[];
  if(!diagnostics.some(d=>JSON.stringify(d)===JSON.stringify(safe))){
   // At most one execution failure and its persistence failures are expected.
   if(diagnostics.length<4)diagnostics.push(safe);
   reportCodeFailure(run,safe);
  }
 };
 const update=async(status:string,terminal=false)=>{
  run.status=status;run.terminal=terminal;run.updatedAt=Date.now();
  try{await persist(stored);}catch(error){
   persistenceFailed=true;diagnose({...location,operation:'PERSIST',category:'PERSISTENCE_FAILED'});throw error;
  }
 };
 async function execute(stdin:string,suffix:string,visible:boolean,checkIndex?:number){
  location={stage:visible?'VISIBLE':'PRIVATE_CHECK',operation:'SUBMIT',workerJobId:null,...(checkIndex===undefined?{}:{checkIndex})};
  if(cancelled())return null;
  let job=compiler.submit({requestId:run.jobId+'-'+suffix,source:run.source,stdin});
  location.workerJobId=job.id;
  const rememberPhase=()=>{if('phase' in job&&(job.phase==='queue'||job.phase==='compile'||job.phase==='run'))location.workerPhase=job.phase;};
  rememberPhase();
  if(visible)run.workerJobId=job.id;
  let last='';
  while(!job.terminal){
   if(cancelled()){location.operation='CANCEL';await compiler.cancel(job.id);}
   if(visible&&job.state!==last){last=job.state;await update(job.state);}
   await new Promise(r=>setTimeout(r,80));
   location.operation='READ';
   const next=compiler.read(job.id);
   if(!next){failureCategory='MISSING_JOB';throw Error('Worker result missing');}
   job=next;
   rememberPhase();
  }
  location.operation='RESULT';
  if(unconfirmed(job.state))diagnose({...location,category:categoryFor(job.state)});
  if(visible){
   run.stdout=job.result?.execution?.stdout??'';
   run.stderr=unconfirmed(job.state)?UNCONFIRMED_CODE_MESSAGE:job.result?.compilation?.stderr||job.result?.execution?.stderr||'';
  }else{
   // Record even UNKNOWN/CANCELLED before taking any early return. No private output is copied.
   (stored.privateChecks??=[]).push({workerJobId:job.id,sourceHash:job.sourceHash,inputHash:job.inputHash,status:job.state});
  }
  return job;
 }
 try {
  const sample=await execute(run.stdin,'visible',true);
  // A cancellation request does not prove that an uncertain worker stopped.
  if(sample&&unconfirmed(sample.state)){run.stderr=UNCONFIRMED_CODE_MESSAGE;await update('UNKNOWN',true);return;}
  if(cancelled()||sample?.state==='CANCELLED'){await update('CANCELLED',true);return;}
  if(!sample||sample.state!=='OK'){await update(sample?.state??'UNKNOWN',true);return;}
  await update('CHECKING');
  let passed=true;
  for(let i=0;i<privateInputs.length;i++){
   const item=privateInputs[i],input=typeof item==='number'?item+'\n':item.stdin,expected=typeof item==='number'?triangle(item):item.stdout,result=await execute(input,'private-'+i,false,i);
   if(result&&unconfirmed(result.state)){run.stderr=UNCONFIRMED_CODE_MESSAGE;await update('UNKNOWN',true);return;}
   if(cancelled()||result?.state==='CANCELLED'){await update('CANCELLED',true);return;}
   if(!result){run.stderr=UNCONFIRMED_CODE_MESSAGE;await update('UNKNOWN',true);return;}
   if(result.state!=='OK'||(typeof item!=='number'&&item.mode==='tokens'?(result.result?.execution?.stdout??'').trim().split(/\s+/).join(' ')!==expected.trim().split(/\s+/).join(' '):normalizeOutput(result.result?.execution?.stdout??'')!==normalizeOutput(expected)))passed=false;
   // Preserve each completed check before starting another worker job.
   await update('CHECKING');
  }
  stored.privatePassed=passed;
  await update('OK',true);
 }catch(error){
  if(!persistenceFailed)diagnose({...location,category:failureCategory});
  stored.privatePassed=null;run.stderr=UNCONFIRMED_CODE_MESSAGE;
  // If this also fails, the lifecycle still latches unresolved and the bounded log survives.
  await update('UNKNOWN',true);
 }
}
