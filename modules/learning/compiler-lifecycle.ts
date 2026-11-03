/** A logical run reserves visible + private jobs before its durable instance identity is written. */
import type {CompilerService} from '../../workers/cpp/compiler.mjs';
import {rondoError} from '../contracts/public/errors';
export type RunCompiler = Pick<CompilerService,'submit'|'read'|'cancel'>;
interface Lease {jobId:string;instanceId:string;compiler:RunCompiler;submitted:number;capacity:number}
export class CompilerLifecycle {
 private used=0;
 private lease:Lease|null=null;
 private changing=false;
 private closing=false;
 private failed=false;
 private unresolved=false;
 private transition:Promise<void>|null=null;
 constructor(private current:CompilerService,private readonly factory?:()=>Promise<CompilerService>,private readonly limit=100){}
 capability(){const c=this.current.capability();return{...c,available:c.available&&!this.failed&&!this.closing};}
 async reserve(jobId:string,capacity:number):Promise<Lease>{
  if(this.closing||this.failed||this.unresolved)throw rondoError('HOST_RECOVERING','执行环境仍有未确认结果，请保留记录，稍后重新进入。');
  if(this.changing||this.lease)throw rondoError('HOST_RECOVERING','另一次代码运行尚未结算，请等它结束后重试本次运行。');
  if(!Number.isInteger(capacity)||capacity<1||capacity>this.limit)throw rondoError('CAPABILITY_UNAVAILABLE','本题的完整核验超出执行环境容量。');
  // This flag is set before any await, including worker verification/rotation.
  this.changing=true;
  try{
   if(this.used+capacity>this.limit){
    if(!this.factory)throw rondoError('CAPABILITY_UNAVAILABLE','执行环境已满，请稍后重新进入。');
    const factory=this.factory;
    this.transition=(async()=>{
     await this.current.close();
     const next=await factory();
     if(this.closing){await next.close();throw Error('Host closing');}
     if(!next.capability().available){await next.close();throw Error('Replacement compiler unavailable');}
     this.current=next;this.used=0;
    })();
    try{await this.transition;}catch(error){this.failed=true;throw rondoError('CAPABILITY_UNAVAILABLE','执行环境切换未完成；已有结果仍保留，请稍后重试。');}finally{this.transition=null;}
   }
   if(!this.current.capability().available)throw rondoError('CAPABILITY_UNAVAILABLE','本机隔离编译器不可用。');
   const worker=this.current;
   const lease:Lease={jobId,instanceId:worker.capability().instanceId,submitted:0,capacity,compiler:{
    submit:payload=>{
     if(this.lease!==lease||lease.submitted>=lease.capacity)throw Error('Run capacity reservation exhausted');
     lease.submitted++;this.used++;
     return worker.submit(payload);
    },read:id=>worker.read(id),cancel:id=>worker.cancel(id),
   }};
   this.lease=lease;return lease;
  }finally{this.changing=false;}
 }
 forRun(jobId:string){return this.lease?.jobId===jobId?this.lease:null;}
 forgetDeletionRun(runId:string,instanceId:string){return this.current.forgetDeletionRun?.(runId,instanceId);}
 abort(jobId:string){if(this.lease?.jobId===jobId&&this.lease.submitted===0)this.lease=null;}
 settle(jobId:string,status:string,persisted:boolean){
  if(this.lease?.jobId!==jobId)return;
  // Unknown execution or failed persistence is never made replayable by rotating an instance.
  if(!persisted||status==='UNKNOWN')this.unresolved=true;
  this.lease=null;
 }
 async close(){this.closing=true;await this.transition?.catch(()=>{});await this.current.close();}
}
