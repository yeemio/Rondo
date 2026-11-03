import type {MathResponse,MathState} from '../contracts/public/math6';
import type {ActivityRule} from '../contracts/server/rules-activity';
import type {EvaluationResult} from './evaluate';
import {bigRationalFromDecimalString,makeBigRational,multiplyRational,type BigRational} from './exact';
import {rondoError} from '../contracts/public/errors';
const units:Record<string,{dimension:string;factor:string}>={unitless:{dimension:'none',factor:'1'}};
function register(dimension:string,entries:Record<string,string>){for(const[id,factor]of Object.entries(entries))units[id]={dimension,factor};}
register('length',{'毫米':'1','厘米':'10','分米':'100','米':'1000','千米':'1000000'});
register('area',{'平方毫米':'1','平方厘米':'100','平方分米':'10000','平方米':'1000000','公顷':'10000000000'});
register('volume',{'毫升':'1','升':'1000','立方米':'1000000'});register('mass',{'克':'1','千克':'1000','吨':'1000000'});register('time',{'秒':'1','分钟':'60','小时':'3600','天':'86400'});
for(const id of ['元','人','棵','台','份','段','支','个','次','场','格','枚','度','平方米/分','米/分','元/千克','米/秒','千米/时'])register(id,{[id]:'1'});
export function parseMathNumber(text:string):BigRational{const f=/^(-?\d{1,9})\/([1-9]\d{0,8})$/.exec(text);return f?makeBigRational(BigInt(f[1]),BigInt(f[2])):bigRationalFromDecimalString(text);}
function equal(a:BigRational,b:BigRational){return a.num*b.den===b.num*a.den;}
export function mathQuantityEqual(value:MathResponse['answers'][number],expected:string,unit:string):boolean{
 if(value.kind!=='quantity')return false;const actualUnit=units[value.unit],targetUnit=units[unit];if(!actualUnit||!targetUnit||actualUnit.dimension!==targetUnit.dimension)return false;
 const v=value.value.kind==='fraction'?makeBigRational(BigInt(value.value.numerator),BigInt(value.value.denominator)):bigRationalFromDecimalString(value.value.value);
 return equal(multiplyRational(v,parseMathNumber(actualUnit.factor)),multiplyRational(parseMathNumber(expected),parseMathNumber(targetUnit.factor)));
}
export function evaluateMath6(rule:ActivityRule,state:MathState,response:MathResponse):EvaluationResult{
 const truth=rule.math;if(!truth||truth.lessonId!==state.lessonId||response.lessonId!==state.lessonId)throw rondoError('INVALID_OPERATION','数学回答与当前教材活动不对应。');
 if(state.trials.length===0)throw rondoError('INVALID_OPERATION','请先操作模型并保存一条观察记录，再提交。');
 if(truth.mode==='observe'){
  if(response.answers.length||!state.observation.trim())throw rondoError('INVALID_OPERATION','这是一项观察活动，请保留自己的观察原文。');
  return{outcome:'UNSCORABLE',feedback:{ruleKind:'FAMILY_TRUTH_V1',assessmentMode:{version:'math.assessment.v1',mode:'OBSERVATION_RECORDED'},scenarioMet:true,responseTypeOk:true,itemResults:[],diagnostics:['观察已记录 · 不作正确性判定。完成只表示这次记录、解释流程结束，不表示掌握。'],reveal:{explanation:truth.explanation}}};
 }
 if(response.answers.length!==truth.checks.length||new Set(response.answers.map(x=>x.id)).size!==truth.checks.length||response.answers.some(x=>!truth.checks.some(c=>c.id===x.id)))throw rondoError('INVALID_OPERATION','请给本活动每个登记问题各回答一次。');
 const items=truth.checks.map(c=>{const a=response.answers.find(x=>x.id===c.id)!;const correct=c.kind==='choice'?a.kind==='choice'&&c.accepted!.includes(a.optionId):mathQuantityEqual(a,c.value!,c.unit!);return{key:c.id,label:c.label??c.id,verdict:correct?'CORRECT' as const:'REVISE' as const,feedback:correct?'这项数值/选择与本题约定一致。':c.feedback};});
 const constructed=Object.entries(truth.construction).every(([key,value])=>state.values[key]===value),correct=constructed&&items.every(x=>x.verdict==='CORRECT');
 return{outcome:correct?'CORRECT':'REVISE',feedback:{ruleKind:'FAMILY_TRUTH_V1',assessmentMode:{version:'math.assessment.v1',mode:'RULE_CHECKED'},scenarioMet:constructed,responseTypeOk:true,itemResults:items,diagnostics:[...items.map(x=>x.feedback),...(constructed?[]:['模型构造尚未对应本题要求，请检查倍率、方向、角度或位置。']),'核对只针对本题登记的数值、单位与构造条件；观察和解释原文没有被自动判为掌握。'],reveal:{explanation:truth.explanation}}};
}
