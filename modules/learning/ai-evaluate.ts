import type {ActivityState} from '../contracts/public/activity';
import type {AILabAnswer,NewAIId} from '../contracts/public/ai-lab';
import {AI_TIMELINE_IDS,splitTeachingTokens} from '../contracts/public/ai-lab';
import type {ActivityRule} from '../contracts/server/rules-activity';
import type {EvaluationResult} from './evaluate';
import {rondoError} from '../contracts/public/errors';
/** Score the child's concepts against private truth; observations alone never imply mastery. */
export function evaluateAILab(rule:ActivityRule,state:ActivityState,answer:AILabAnswer):EvaluationResult{
 const lab=state.lab;if(!lab||'ai-'+lab.kind!==rule.activity)throw rondoError('INVALID_OPERATION','活动状态与本题不匹配。');
 const keys=Object.keys(rule.choices),submitted=answer.choices.map(x=>x.itemId);
 if(submitted.length!==keys.length||new Set(submitted).size!==submitted.length||submitted.some(x=>!keys.includes(x)))throw rondoError('INVALID_OPERATION','请只回答这项活动登记的问题。');
 let concepts=answer.choices.every(x=>rule.choices[x.itemId]===x.optionId),observed=false,cue='请再对照一次自己的操作与问题。';
 switch(lab.kind){
  case'a1':{
   const assignments=answer.memberships??[];if(assignments.length!==3||new Set(assignments.map(x=>x.systemId)).size!==3)throw rondoError('INVALID_OPERATION','三个系统都需要留下类别判断。');
   const truth:Record<string,string[]>={search:['ai'],image:['ai','ml'],story:['ai','ml','generative']};concepts=assignments.every(x=>x.categories.length===truth[x.systemId].length&&x.categories.every(c=>truth[x.systemId].includes(c)));observed=lab.viewed.length===3;cue='再看系统的工作方式：规则搜索、从样本学习、生成新内容可以怎样区分和包含？';break;
  }
  case'a2':observed=lab.moves>0&&lab.order.every((x,i)=>x===AI_TIMELINE_IDS[i]);cue='先核对提案与计划的先后，再比较研究任务；这条线是不是全部历史？';break;
  case'a3':observed=lab.trials.length>=2&&new Set(lab.trials.map(x=>JSON.stringify(x.examples))).size>=2&&lab.trials.some(t=>!t.examples.some(e=>e.width===t.query.width&&e.height===t.query.height));cue='需要一次改例子前后的真实比较。再看：模型沿用谁的标签，未覆盖的新情况能否保证？';break;
  case'a4':observed=new Set(lab.training.map(x=>x.weight)).size>=2&&lab.phase==='FROZEN'&&lab.trials.length>0&&lab.trials.at(-1)!.weight===lab.frozenWeight;cue='先调整、对照，再冻结测试；把参数变化与使用参数计算分开。';break;
  case'a5':observed=new Set(lab.segmentations.map(x=>splitTeachingTokens(x).length)).size>=2;cue='请保留两种片段数不同的切法，再想想纸面切分与真实tokenizer的区别。';break;
  case'a6':observed=lab.visited.length===2&&lab.links.animal==='cat'&&lab.links.chair==='chair'&&lab.continuations.animal==='rest-cat'&&lab.continuations.chair==='move-chair';cue='在两段上下文中分别连线并试续句；再区分阅读类比、真实模型机制与真值核查。';break;
  case'a8':observed=lab.plans.ideas==='assist-review'&&lab.plans.learn==='assist-review'&&['do-myself','ask-adult'].includes(lab.plans.homework??'')&&['ask-adult','do-myself'].includes(lab.plans.privacy??'');cue='逐个比较辅助、代交和无关个人资料；人负责哪一步？';break;
 }
 if(lab.kind!=='a1'&&answer.memberships!==undefined)throw rondoError('INVALID_OPERATION','本活动不接受系统类别回答。');
 const correct=observed&&concepts,detail=correct?'这次操作和判断对应上了。再用自己的话说明依据；完成一次活动不等于已经掌握。':cue;
 return{outcome:correct?'CORRECT':'REVISE',feedback:{ruleKind:'FAMILY_TRUTH_V1',scenarioMet:observed,responseTypeOk:true,itemResults:[{key:'lab',label:'活动与概念核对',verdict:correct?'CORRECT':'REVISE',feedback:detail}],diagnostics:[detail],reveal:{explanation:rule.explanation}}};
}
