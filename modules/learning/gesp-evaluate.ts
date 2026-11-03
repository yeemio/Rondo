import type {ActivityRule} from '../contracts/server/rules-activity';
import type {GespState} from '../contracts/public/gesp';
import type {StructuredResponseItem} from '../contracts/public/envelope';
import {GESP_LESSONS} from '../curriculum/gesp';
import {rondoError} from '../contracts/public/errors';
import type {EvaluationResult} from './evaluate';

/** Answers and per-choice feedback remain server-only. Text reasoning is preserved, not graded. */
export function evaluateGespObjective(rule:ActivityRule,record:GespState,response:StructuredResponseItem[]):EvaluationResult{
 const truth=rule.gesp,question=GESP_LESSONS.find(q=>q.id===truth?.questionId);
 if(!truth||!question||record.questionId!==truth.questionId||question.kind==='program')throw rondoError('INVALID_OPERATION','题目与本次推演不匹配。');
 if(response.length!==1||response[0].kind!=='singleChoice'||response[0].selectionId!==truth.questionId||!(question.kind==='mcq'?['A','B','C','D','ISSUE']:['T','F','ISSUE']).includes(response[0].optionId))throw rondoError('INVALID_OPERATION','请提交本题登记的选择。');
 const selected=response[0].optionId,reasoned=Object.values(record.reasoning).every(text=>text.trim().length>0),accepted=reasoned&&truth.acceptedAnswers.some(answer=>answer===selected);
 const issue=accepted&&selected==='ISSUE'&&truth.assessmentVersion==='gesp.assessment.v1';
 const detail=!reasoned?'请把输入理解、关键步骤和边界核对分别留在推演记录里，再提交。':accepted?(truth.choiceFeedback?.[selected]??'这次选择与课程语义核对一致。推演原文已保存，接着说明自己的依据；一次选择不代表掌握。'):'请按公开的核对范围区分局部选择与整题前提，再检查条件、执行顺序和边界。';
 return{outcome:issue?'UNSCORABLE':accepted?'CORRECT':'REVISE',feedback:{
  ruleKind:'FAMILY_TRUTH_V1',scenarioMet:reasoned,responseTypeOk:true,
  ...(truth.assessmentVersion?{assessmentMode:{version:truth.assessmentVersion,mode:issue?'ISSUE_RECORDED' as const:'CHOICE_CHECKED' as const}}:{}),
  itemResults:issue?[]:[{key:'gesp',label:truth.assessmentVersion?'公开范围内的选择核对':'本题核对',verdict:accepted?'CORRECT':'REVISE',feedback:detail}],
  diagnostics:[detail],reveal:{explanation:rule.explanation},
 }};
}
