/** Closed teaching simulations. Public examples/model outputs are observations, never grading truth. */
import {z} from 'zod';
export const AI_NEW_IDS=['ai-a1','ai-a2','ai-a3','ai-a4','ai-a5','ai-a6','ai-a8'] as const;
export type NewAIId=typeof AI_NEW_IDS[number];
export const AI_SYSTEM_IDS=['search','image','story'] as const;
export const AI_TIMELINE_IDS=['proposal1955','plan1956','vision2012','transformer2017','gpt32020','chatgpt2022'] as const;
export const labelSchema=z.enum(['tall','broad']);
const exampleSchema=z.object({id:z.string().max(12),width:z.number().int().min(1).max(10),height:z.number().int().min(1).max(10),label:labelSchema}).strict();
const pointSchema=z.object({width:z.number().int().min(1).max(10),height:z.number().int().min(1).max(10)}).strict();
const contextSchema=z.enum(['animal','chair']),targetSchema=z.enum(['cat','chair']),continuationSchema=z.enum(['rest-cat','move-chair']);
export const AI_USE_SCENARIOS=['ideas','learn','homework','privacy'] as const;
const useDecisionSchema=z.enum(['assist-review','do-myself','ask-adult','copy-submit','share-private']);
export const aiLabStateSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('a1'),viewed:z.array(z.enum(AI_SYSTEM_IDS)).max(3)}).strict(),
 z.object({kind:z.literal('a2'),order:z.array(z.enum(AI_TIMELINE_IDS)).length(6).refine(a=>new Set(a).size===6),moves:z.number().int().min(0)}).strict(),
 z.object({kind:z.literal('a3'),examples:z.array(exampleSchema).min(1).max(8),revision:z.number().int().min(0),query:pointSchema,trials:z.array(z.object({query:pointSchema,predicted:labelSchema,nearestId:z.string(),distanceSquared:z.number(),revision:z.number(),examples:z.array(exampleSchema)}).strict()).max(24)}).strict(),
 z.object({kind:z.literal('a4'),weight:z.number().int().min(1).max(3),phase:z.enum(['TRAINING','FROZEN']),frozenWeight:z.number().int().min(1).max(3).nullable(),training:z.array(z.object({weight:z.number(),errors:z.number()}).strict()).max(24),trials:z.array(z.object({query:pointSchema,weight:z.number(),predicted:labelSchema}).strict()).max(24)}).strict(),
 z.object({kind:z.literal('a5'),cuts:z.array(z.number().int().min(1).max(6)).max(6).refine(a=>new Set(a).size===a.length),segmentations:z.array(z.array(z.number().int().min(1).max(6))).max(24)}).strict(),
 z.object({kind:z.literal('a6'),context:contextSchema,visited:z.array(contextSchema).max(2),links:z.object({animal:targetSchema.nullable(),chair:targetSchema.nullable()}).strict(),continuations:z.object({animal:continuationSchema.nullable(),chair:continuationSchema.nullable()}).strict()}).strict(),
 z.object({kind:z.literal('a8'),plans:z.object({ideas:useDecisionSchema.nullable(),learn:useDecisionSchema.nullable(),homework:useDecisionSchema.nullable(),privacy:useDecisionSchema.nullable()}).strict()}).strict(),
]);
export type AILabState=z.infer<typeof aiLabStateSchema>;
export const aiLabOperationSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('InspectAISystem'),systemId:z.enum(AI_SYSTEM_IDS)}).strict(),
 z.object({type:z.literal('MoveAITimeline'),eventId:z.enum(AI_TIMELINE_IDS),to:z.number().int().min(0).max(5)}).strict(),
 z.object({type:z.literal('RelabelAIExample'),exampleId:z.string().max(12),label:labelSchema}).strict(),
 z.object({type:z.literal('AddAIExample'),width:z.number().int().min(1).max(10),height:z.number().int().min(1).max(10),label:labelSchema}).strict(),
 z.object({type:z.literal('TestAIClassifier'),width:z.number().int().min(1).max(10),height:z.number().int().min(1).max(10)}).strict(),
 z.object({type:z.literal('AdjustAIParameter'),value:z.number().int().min(1).max(3)}).strict(),
 z.object({type:z.literal('FreezeAIModel')}).strict(),
 z.object({type:z.literal('RestartAITraining')}).strict(),
 z.object({type:z.literal('TestAIFrozenModel'),width:z.number().int().min(1).max(10),height:z.number().int().min(1).max(10)}).strict(),
 z.object({type:z.literal('SetAITokenCuts'),cuts:z.array(z.number().int().min(1).max(6)).max(6).refine(a=>new Set(a).size===a.length)}).strict(),
 z.object({type:z.literal('SetAIContext'),context:contextSchema}).strict(),
 z.object({type:z.literal('ConnectAIPronoun'),target:targetSchema}).strict(),
 z.object({type:z.literal('TryAIContinuation'),continuation:continuationSchema}).strict(),
 z.object({type:z.literal('PlanAIUse'),scenario:z.enum(AI_USE_SCENARIOS),decision:useDecisionSchema}).strict(),
]);
export type AILabOperation=z.infer<typeof aiLabOperationSchema>;
export const AI_CHOICE_IDS=['history-selection','history-start','nearest-rule','unseen-case','training-action','inference-action','token-unit','token-model','context-link','fluent-truth','responsibility','privacy-rule']as const;
export const aiLabResponseSchema=z.object({kind:z.literal('aiLabAnswer'),version:z.literal('ai.answers.v1'),choices:z.array(z.object({itemId:z.enum(AI_CHOICE_IDS),optionId:z.enum(['selection-only','whole-history','research-before-chat','chat-start','nearest-example','understands-rule','not-guaranteed','always-correct','changes-parameters','only-reads','uses-frozen','relearns-every-query','variable-pieces','one-character','depends-on-encoding','fixed-count','reading-analogy','real-attention','needs-evidence','fluent-is-true','person-responsible','ai-responsible','minimize-data','share-to-improve'])}).strict()).max(12),memberships:z.array(z.object({systemId:z.enum(AI_SYSTEM_IDS),categories:z.array(z.enum(['ai','ml','generative'])).max(3).refine(a=>new Set(a).size===a.length)}).strict()).max(3).optional()}).strict();
export type AILabAnswer=z.infer<typeof aiLabResponseSchema>;
export const TOKEN_SENTENCE='小猫喜欢晒太阳';
export const INITIAL_AI_EXAMPLES=[{id:'A',width:2,height:7,label:'tall' as const},{id:'B',width:3,height:8,label:'tall' as const},{id:'C',width:7,height:5,label:'broad' as const},{id:'D',width:8,height:7,label:'broad' as const}];
export const TRAINING_AI_EXAMPLES=[{width:2,height:7,label:'tall'},{width:4,height:6,label:'broad'},{width:6,height:8,label:'broad'}] as const;
export function nearestAIExample(examples:readonly {id:string;width:number;height:number;label:'tall'|'broad'}[],query:{width:number;height:number}){return examples.map((item,order)=>({...item,order,distanceSquared:(item.width-query.width)**2+(item.height-query.height)**2})).sort((a,b)=>a.distanceSquared-b.distanceSquared||a.order-b.order)[0];}
export function scoreAIModel(weight:number,query:{width:number;height:number}):'tall'|'broad'{return query.height-weight*query.width>=0?'tall':'broad';}
export function splitTeachingTokens(cuts:readonly number[]){const chars=[...TOKEN_SENTENCE],bounds=[0,...cuts.slice().sort((a,b)=>a-b),chars.length];return bounds.slice(1).map((end,i)=>chars.slice(bounds[i],end).join(''));}
export function initialAILab(id:NewAIId):AILabState{
 switch(id){case'ai-a1':return{kind:'a1',viewed:[]};case'ai-a2':return{kind:'a2',order:['chatgpt2022','vision2012','proposal1955','gpt32020','plan1956','transformer2017'],moves:0};case'ai-a3':return{kind:'a3',examples:INITIAL_AI_EXAMPLES.map(x=>({...x})),query:{width:4,height:7},revision:0,trials:[]};case'ai-a4':return{kind:'a4',weight:1,phase:'TRAINING',frozenWeight:null,training:[{weight:1,errors:2}],trials:[]};case'ai-a5':return{kind:'a5',cuts:[2,4],segmentations:[[2,4]]};case'ai-a6':return{kind:'a6',context:'animal',visited:['animal'],links:{animal:null,chair:null},continuations:{animal:null,chair:null}};case'ai-a8':return{kind:'a8',plans:{ideas:null,learn:null,homework:null,privacy:null}};}
}
export const AI_OPERATIONS:Record<NewAIId,readonly AILabOperation['type'][]>= {
 'ai-a1':['InspectAISystem'],'ai-a2':['MoveAITimeline'],'ai-a3':['RelabelAIExample','AddAIExample','TestAIClassifier'],'ai-a4':['AdjustAIParameter','FreezeAIModel','RestartAITraining','TestAIFrozenModel'],'ai-a5':['SetAITokenCuts'],'ai-a6':['SetAIContext','ConnectAIPronoun','TryAIContinuation'],'ai-a8':['PlanAIUse'],
};
/** Returns null for an unregistered/wrong-stage operation. Host persists the resulting state. */
export function applyAILabOperation(activity:NewAIId,state:AILabState,op:AILabOperation):AILabState|null{
 if(state.kind!==activity.slice(3)||!AI_OPERATIONS[activity].includes(op.type))return null;
 if(state.kind==='a1'&&op.type==='InspectAISystem')return{...state,viewed:[...new Set([...state.viewed,op.systemId])]};
 if(state.kind==='a2'&&op.type==='MoveAITimeline'){const order=state.order.filter(x=>x!==op.eventId);order.splice(op.to,0,op.eventId);return{...state,order,moves:state.moves+1};}
 if(state.kind==='a3'){
  if(op.type==='RelabelAIExample'){if(!state.examples.some(x=>x.id===op.exampleId))return null;return{...state,revision:state.revision+1,examples:state.examples.map(x=>x.id===op.exampleId?{...x,label:op.label}:x)};}
  if(op.type==='AddAIExample'){if(state.examples.length>=8)return null;return{...state,revision:state.revision+1,examples:[...state.examples,{id:'N'+(state.examples.length-3),width:op.width,height:op.height,label:op.label}]};}
  if(op.type==='TestAIClassifier'){if(state.trials.length>=24)return null;const query={width:op.width,height:op.height},nearest=nearestAIExample(state.examples,query);return{...state,query,trials:[...state.trials,{query,predicted:nearest.label,nearestId:nearest.id,distanceSquared:nearest.distanceSquared,revision:state.revision,examples:state.examples.map(x=>({...x}))}]};}
 }
 if(state.kind==='a4'){
  if(op.type==='AdjustAIParameter'){if(state.phase!=='TRAINING'||state.training.length>=24)return null;const errors=TRAINING_AI_EXAMPLES.filter(x=>scoreAIModel(op.value,x)!==x.label).length;return{...state,weight:op.value,training:[...state.training,{weight:op.value,errors}]};}
  if(op.type==='FreezeAIModel')return state.phase==='TRAINING'?{...state,phase:'FROZEN',frozenWeight:state.weight}:null;
  if(op.type==='RestartAITraining')return{...state,phase:'TRAINING',frozenWeight:null};
  if(op.type==='TestAIFrozenModel'){if(state.phase!=='FROZEN'||state.frozenWeight===null||state.trials.length>=24)return null;const query={width:op.width,height:op.height};return{...state,trials:[...state.trials,{query,weight:state.frozenWeight,predicted:scoreAIModel(state.frozenWeight,query)}]};}
 }
 if(state.kind==='a5'&&op.type==='SetAITokenCuts'){if(state.segmentations.length>=24)return null;const cuts=op.cuts.slice().sort((a,b)=>a-b);return{...state,cuts,segmentations:[...state.segmentations,cuts]};}
 if(state.kind==='a6'){
  if(op.type==='SetAIContext')return{...state,context:op.context,visited:[...new Set([...state.visited,op.context])]};
  if(op.type==='ConnectAIPronoun')return{...state,links:{...state.links,[state.context]:op.target}};
  if(op.type==='TryAIContinuation')return{...state,continuations:{...state.continuations,[state.context]:op.continuation}};
 }
 if(state.kind==='a8'&&op.type==='PlanAIUse')return{...state,plans:{...state.plans,[op.scenario]:op.decision}};
 return null;
}
