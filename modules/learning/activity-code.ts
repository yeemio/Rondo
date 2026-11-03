/** Versioned integration of the accepted b2 worker. Durable facts stay in learningEvent. */
import { createHash } from 'node:crypto';
import type { CodeSnapshot } from '../contracts/public/activity';
import type { RunCompiler } from './compiler-lifecycle';
export const hashText=(text:string)=>createHash('sha256').update(text).digest('hex');
export function triangle(n:number):string { let k=0; return Array.from({length:n},(_,i)=>Array.from({length:i+1},()=>String.fromCharCode(65+k++%26)).join('')).join('\n')+'\n'; }
export function normalizeOutput(text:string):string { return text.replace(/\r\n/g,'\n').replace(/\n$/,''); }
export interface StoredCodeRun { run: CodeSnapshot; privatePassed: boolean|null; privateChecks?:Array<{workerJobId:string;sourceHash:string;inputHash:string;status:string}>; }
export async function executeActivityCode(compiler:RunCompiler, stored:StoredCodeRun, privateInputs:number[]|Array<{stdin:string;stdout:string;mode:'exact'|'tokens';label:string}>, persist:(run:StoredCodeRun)=>Promise<void>, cancelled:()=>boolean):Promise<void>{
 const run=stored.run;
 const update=async(status:string,terminal=false)=>{run.status=status;run.terminal=terminal;run.updatedAt=Date.now();await persist(stored);};
 async function execute(stdin:string,suffix:string,visible:boolean){
  if(cancelled()) return null;
  let job=compiler.submit({requestId:run.jobId+'-'+suffix,source:run.source,stdin});
  if(visible)run.workerJobId=job.id;
  let last='';
  while(!job.terminal){
   if(cancelled()) await compiler.cancel(job.id);
   if(visible&&job.state!==last){last=job.state;await update(job.state);}
   await new Promise(r=>setTimeout(r,80));
   job=compiler.read(job.id)!;
  }
  if(visible){run.stdout=job.result?.execution?.stdout??'';run.stderr=job.result?.compilation?.stderr||job.result?.execution?.stderr||job.result?.infrastructureError||'';}
  return job;
 }
 try {
  const sample=await execute(run.stdin,'visible',true);
  if(cancelled()||sample?.state==='CANCELLED'){await update('CANCELLED',true);return;}
  if(!sample||sample.state!=='OK'){await update(sample?.state??'UNKNOWN',true);return;}
  await update('CHECKING');
  let passed=true;
  for(let i=0;i<privateInputs.length;i++){
   const item=privateInputs[i],input=typeof item==='number'?item+'\n':item.stdin,expected=typeof item==='number'?triangle(item):item.stdout, result=await execute(input,'private-'+i,false);
   if(cancelled()||result?.state==='CANCELLED'){await update('CANCELLED',true);return;}
   if(!result||['UNKNOWN','CAPABILITY_UNAVAILABLE','INTERNAL_ERROR'].includes(result.state)){await update('UNKNOWN',true);return;}
   (stored.privateChecks??=[]).push({workerJobId:result.id,sourceHash:result.sourceHash,inputHash:result.inputHash,status:result.state});
   if(result.state!=='OK'||(typeof item!=='number'&&item.mode==='tokens'?(result.result?.execution?.stdout??'').trim().split(/\s+/).join(' ')!==expected.trim().split(/\s+/).join(' '):normalizeOutput(result.result?.execution?.stdout??'')!==normalizeOutput(expected))) passed=false;
  }
  stored.privatePassed=passed;
  await update('OK',true);
 } catch(error){run.stderr='执行环境未能确认结果，请重新运行。'; await update('UNKNOWN',true);}
}
