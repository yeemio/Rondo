import objectives from '../../content/gesp/public/objectives.json';
import programs from '../../content/gesp/public/programs.json';
import type {GESP_TOPICS} from '../contracts/public/gesp';
export interface GespLesson {id:string;session:string;kind:'mcq'|'tf'|'program';number:number;title:string;topic:keyof typeof GESP_TOPICS;extractedText:string;sourceSha256:string;pdfPages:number[];clips:string[];supplement?:string;constraints?:string;meaning?:string;samples?:Array<{stdin:string;stdout:string;label:string}>;coverageNote?:string;}
export const GESP_LESSONS:readonly GespLesson[]=[...objectives,...programs] as GespLesson[];
export const gespReleaseId=(q:GespLesson)=>'rondo.mvp.'+q.id.replaceAll('.','-')+'-r1';
export const GESP_ACTIVITIES=GESP_LESSONS.map(q=>({id:q.kind==='program'?'gesp-program' as const:'gesp-objective' as const,releaseId:gespReleaseId(q),taskId:q.id+'.v1',title:q.title,domain:'GESP C++二级' as const,source:`CCF GESP C++二级 ${q.session.slice(0,4)}年${q.session.slice(4)}月原卷，PDF第${q.pdfPages.join('、')}页；源SHA-256 ${q.sourceSha256}。`,sourceVersion:'gesp-original-'+q.session+'-v1',prompt:[q.meaning??q.extractedText],explain:'结合这道题的具体输入、关键步骤与一个边界，用自己的话说明依据；若发现原卷条件或代码有问题，也请指出。'}));
