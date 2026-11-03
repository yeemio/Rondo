export class CompilerService {
 constructor(config: {compilerContractId:string;imageId:string;platform:string});
 verify():Promise<void>;
 capability():{available:boolean;instanceId:string};
 submit(payload:{requestId:string;source:string;stdin:string}):WorkerRun;
 read(id:string):WorkerRun|null;
 cancel(id:string):Promise<WorkerRun|null>;
 close():Promise<void>;
 forgetDeletionRun?(runId:string,instanceId:string):{owned:boolean;deleted:number;pending:number};
}
export interface WorkerRun {id:string;requestId:string;instanceId:string;state:string;terminal:boolean;sourceHash:string;inputHash:string;result:null|{compilation?:{stderr:string};execution?:{stdout:string;stderr:string};infrastructureError?:string};}
