import {mathLessonForRelease,type MathLesson} from './math6';
import {gespLessonForRelease} from './gesp';
import type {DailyEntry,DailyScope} from '../contracts/public/daily';

export interface DailyPoolEntry extends DailyEntry {scope:DailyScope;}
const shortScope='本次只练原课中标明的一问，核对回答后可纠错或继续；不代替原课的模型探索、预测和解释。完整课程仍可从课程目录打开。';
function math(lessonId:string,questionId:string,skill:string,prompt:string,basis:string):DailyPoolEntry {
  const releaseId='rondo.mvp.'+lessonId.replaceAll('.','-')+'-r1',q=mathLessonForRelease(releaseId,lessonId+'.v1')!;
  return {poolId:lessonId+'.'+questionId+'.daily1',lessonId,releaseId,taskId:lessonId+'.v1',
    taskVersion:'1',scope:'math',workflow:'daily.short.v1',questionIds:[questionId],
    title:q.questions.find(x=>x.id===questionId)!.label,skill,prompt,scopeNote:shortScope,selectionBasis:basis};
}
function gesp(lessonId:string,skill:string,basis:string):DailyPoolEntry {
  const releaseId='rondo.mvp.'+lessonId.replaceAll('.','-')+'-r1',q=gespLessonForRelease(releaseId,lessonId+'.v1')!;
  return {poolId:lessonId+'.daily1',lessonId,releaseId,taskId:lessonId+'.v1',
    taskVersion:'1',scope:'gesp',workflow:'daily.short.v1',questionIds:[lessonId],
    title:q.title,skill,prompt:q.extractedText,scopeNote:'按原题核对这一项选择；本次短练不要求模板推演。原卷题面与来源保留，完整推演可从课程目录进入。',selectionBasis:basis};
}
const circle=mathLessonForRelease('rondo.mvp.math6-b16-r2','math6.b16.v1')!;
/** Frozen daily v1 allowlist: 14 entries. Retain this version when adding future pools. No answers here. */
export const DAILY_POOL:readonly DailyPoolEntry[]=[
  math('math6.u1-03','q1','小数乘法','计算0.8×0.03。可以先估计积的大小，再填写结果。','既有积的小数位数练习；数值确定，不依赖模型动作。'),
  math('math6.u1-06','q3','小数乘法','正数4.9乘0.99后，积与4.9相比怎样？','既有乘数与1的大小关系判断；比较条件完整。'),
  math('math6.u1-08','q2','小数除法','计算0.34÷0.017，注意被除数和除数要同时扩大。','既有商不变规律练习；准确商可验证，无近似边界。'),
  math('math6.u1-05','q1','近似值','苹果6.25元/千克，买1.5千克。应付多少元？按四舍五入保留两位小数。','既有付款练习；数量、单位与取近似值规则明确。'),
  math('math6.b17','q1','圆','同一圆中，90°扇形占整圆的几分之几？可填写小数或分数。','只取既有圆心角份额计算；完整原课仍保留角度操作比较。'),
  math('math6.u1-09','q2','近似值','计算3.5÷1.1，按四舍五入保留两位小数。','既有求商近似值练习；保留位数明确。'),
  math('math6.u1-10','q1','小数除法','用300元买每支3.5元的笔，最多可以买多少支？','既有预算情境；整支数量不得超过预算。'),
  {poolId:'math6.b16.model.daily1',lessonId:circle.id,releaseId:'rondo.mvp.math6-b16-r2',taskId:circle.id+'.v1',taskVersion:'2',scope:'math',workflow:'daily.model.v1',questionIds:circle.questions.map(q=>q.id),title:'建两个不同的圆',skill:'圆',prompt:circle.challenge,scopeNote:'先猜想，按顺序保存两个圆，回答并解释比较依据。',selectionBasis:'题面分别给出半径与直径，两个圆的尺寸可以用模型记录对应比较。'},
  gesp('gesp2.202303.mcq05','标识符与语法','关键字与库函数名的既有选择题；无运行或浮点前提。'),
  gesp('gesp2.202303.mcq06','运算符','既有运算符拼写题；符号条件完整。'),
  gesp('gesp2.202303.mcq10','运算符','既有复合赋值题；给定a=9，运算在int范围内。'),
  gesp('gesp2.202303.tf05','标识符与语法','既有字符字面量判断；变量与字面量明确分开。'),
  gesp('gesp2.202303.tf07','循环条件','既有while判断；先检查条件、可执行零次。'),
  gesp('gesp2.202303.tf08','运算符','既有运算符顺序判断；不依赖未指定的数值范围。'),
];
export function dailyPoolEntry(id:string):DailyPoolEntry|undefined{return DAILY_POOL.find(x=>x.poolId===id);}
export function dailyMathLesson(entry:DailyEntry):MathLesson|undefined {
  const source=mathLessonForRelease(entry.releaseId,entry.taskId);
  return source?{...source,questions:source.questions.filter(q=>entry.questionIds.includes(q.id))}:undefined;
}
