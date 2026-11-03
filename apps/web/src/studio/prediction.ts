import type {ActivityState} from '../../../../modules/contracts/public/activity';
import type {RecordPredictionPayload} from '../../../../modules/contracts/public/envelope';
/** Preserve the learner's exact wording and their explicit uncertainty choice. */
export function activityPredictionPayload(activityId:ActivityState['activity'],statement:string,uncertain:boolean):RecordPredictionPayload {
 return {prediction:{kind:'activity.statement.v1',activityId,statement},uncertain};
}

export async function submitActivityPrediction(input:{
 activityId:ActivityState['activity'];draft:ActivityState['draft'];
 save:()=>Promise<import('../../../../modules/contracts/public/receipts').CommandReceipt|null>;
 send:(kind:'learning.recordPrediction',payload:RecordPredictionPayload,version?:number)=>Promise<import('../../../../modules/contracts/public/receipts').CommandReceipt|null>;
}){
 const saved=await input.save();
 if(!saved)return null;
 return input.send('learning.recordPrediction',activityPredictionPayload(input.activityId,input.draft.prediction,input.draft.uncertain===true),saved.attemptVersion);
}
