/** A logical run reserves visible + private jobs before its durable instance identity is written. */
import type {CompilerService} from '../../workers/cpp/compiler.mjs';
import type {CodeAvailability} from '../contracts/public/activity';
export type RunCompiler = Pick<CompilerService,'submit'|'read'|'cancel'>;
interface Lease {jobId:string;instanceId:string;compiler:RunCompiler;submitted:number;capacity:number}
/** Only reserve may issue this proof: no worker submit has happened for this request. */
export class CompilerAdmissionRejected extends Error {
 constructor(readonly code:'HOST_RECOVERING'|'CAPABILITY_UNAVAILABLE',message:string){super(message);}
}
export class CompilerLifecycle {
 private used=0;
 private lease:Lease|null=null;
 private changing=false;
 private closing=false;
 private failed=false;
 private unresolved=false;
 private readonly unresolvedJobs=new Set<string>();
 private transition:Promise<void>|null=null;
 constructor(private current:CompilerService,private readonly factory?:()=>Promise<CompilerService>,private readonly limit=100){}
 capability(capacity=1):ReturnType<CompilerService['capability']>&CodeAvailability {
  const c=this.current.capability();
  const reason:CodeAvailability['reason']=this.unresolved?'UNCONFIRMED':this.closing||this.failed||!c.available?'UNAVAILABLE':
   this.changing||this.lease?'BUSY':!Number.isInteger(capacity)||capacity<1||capacity>this.limit||
    this.used+capacity>this.limit&&!this.factory?'CAPACITY':'READY';
  return {...c,available:reason==='READY',reason};
 }
 isUnresolved(jobId:string){return this.unresolvedJobs.has(jobId);}
 async reserve(jobId:string,capacity:number):Promise<Lease>{
  if(this.closing||this.failed||this.unresolved)throw new CompilerAdmissionRejected('HOST_RECOVERING','编程环境暂不能接受新运行；原代码和未确认记录仍保留，可以先继续其他学习。');
  if(this.changing||this.lease)throw new CompilerAdmissionRejected('HOST_RECOVERING','另一次代码运行尚未结算，本次请求未执行。');
  if(!Number.isInteger(capacity)||capacity<1||capacity>this.limit)throw new CompilerAdmissionRejected('CAPABILITY_UNAVAILABLE','本题的完整核验超出执行环境容量。');
  // This flag is set before any await, including worker verification/rotation.
  this.changing=true;
  try{
   if(this.used+capacity>this.limit){
    if(!this.factory)throw new CompilerAdmissionRejected('CAPABILITY_UNAVAILABLE','执行环境已满，本次请求未执行，可以先继续其他学习。');
    const factory=this.factory;
    this.transition=(async()=>{
     await this.current.close();
     const next=await factory();
     if(this.closing){await next.close();throw Error('Host closing');}
     if(!next.capability().available){await next.close();throw Error('Replacement compiler unavailable');}
     this.current=next;this.used=0;
    })();
    try{await this.transition;}catch(error){this.failed=true;throw new CompilerAdmissionRejected('CAPABILITY_UNAVAILABLE','执行环境切换未完成；本次请求未执行，已有结果仍保留。');}finally{this.transition=null;}
   }
   if(!this.current.capability().available)throw new CompilerAdmissionRejected('CAPABILITY_UNAVAILABLE','本机隔离编译器不可用，本次请求未执行。');
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
  if(!persisted||status==='UNKNOWN'){this.unresolved=true;this.unresolvedJobs.add(jobId);}
  this.lease=null;
 }
 async close(){this.closing=true;await this.transition?.catch(()=>{});await this.current.close();}
}
