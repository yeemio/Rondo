import type {GespState} from '../../../../modules/contracts/public/gesp';
/** Use the learner's exact current notes; never invent reasoning or a default answer. */
export function gespReasoningOperations(state:GespState,answers:Record<string,string>){
 const operations=(['given','steps','check'] as const).map(fieldId=>({type:'RecordGespReasoning' as const,fieldId,text:answers['trace.'+fieldId]??state.reasoning[fieldId]}));
 return operations.every(op=>op.text.trim().length>0)?operations:null;
}
