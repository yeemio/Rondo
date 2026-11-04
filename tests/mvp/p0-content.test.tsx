import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {renderToStaticMarkup} from 'react-dom/server';
import {MATH_LESSONS,MATH_ACTIVITIES,MATH_LEGACY_LESSONS,mathControls,initialMathState,applyMathOperation,parseMathControlInput,nextMathControlValue,mathLessonForRelease,positionFromGrid,type MathLesson} from '../../modules/curriculum/math6';
import {GESP_LESSONS,gespLessonForRelease,gespReleaseId} from '../../modules/curriculum/gesp';
import {supersededActivityNotice} from '../../modules/curriculum/mvp';
import {mathOperationSchema,type MathState,type MathResponse,type MathOperation} from '../../modules/contracts/public/math6';
import {activityRuleSchema,type ActivityRule} from '../../modules/contracts/server/rules-activity';
import {evaluateMath6} from '../../modules/learning/math6-evaluate';
import {evaluateGespObjective} from '../../modules/learning/gesp-evaluate';
import {MathModel,mathReadout,MathHistory,decimalAxisMarks} from '../../apps/web/src/studio/Math6';
import {GespSource,gespIssueRecorded} from '../../apps/web/src/studio/Gesp';
import teaching from '../../content/math6/private/teaching.json';
import frozenHashes from './p0-r1-release-hashes.json';

const lesson=(id:string)=>MATH_LESSONS.find(q=>q.id===id)!;
const rule=(id:string)=>activityRuleSchema.parse({kind:'MVP_ACTIVITY_TRUTH_V1',activity:'math6',choices:{},explanation:'',referenceSource:'',privateInputs:[],math:(teaching as Record<string,unknown>)[id]});
const quantity=(id:string,value:string,unit='unitless')=>({kind:'quantity' as const,id,value:{kind:'decimal' as const,value},unit});
const answer=(id:string,answers:MathResponse['answers']):MathResponse=>({kind:'mathAnswer',version:'math.answers.v1',lessonId:id,answers});
const answers:Record<string,MathResponse>={
 'math6.b16':answer('math6.b16',[quantity('q1','6','厘米'),quantity('q2','1.5','厘米')]),
 'math6.r-04':answer('math6.r-04',[quantity('q1','6','格'),quantity('q2','4','格'),{kind:'choice',id:'q3',optionId:'1'}]),
 'math6.r-07':answer('math6.r-07',[quantity('q1','90','度'),quantity('q2','56.52','米')]),
 'math6.u1-11':answer('math6.u1-11',[quantity('q1','20'),quantity('q2','4','次'),quantity('q3','3.182')]),
 'math6.u7-05':answer('math6.u7-05',[]),
};
function set(q:MathLesson,s:MathState,values:Record<string,number>):MathState{for(const[controlId,value]of Object.entries(values)){const next=applyMathOperation(q,s,{type:'SetMathControl',controlId:controlId as Extract<MathOperation,{type:'SetMathControl'}>['controlId'],value});assert.ok(next,controlId+'='+value);s=next;}return s;}
function capture(q:MathLesson,s:MathState):MathState{const next=applyMathOperation(q,s,{type:'CaptureMathTrial'});assert.ok(next);return next;}
const rejected=(id:string,s:MathState,r=rule(id))=>assert.throws(()=>evaluateMath6(r,s,answers[id]),(e:unknown)=>(e as {code:string}).code==='INVALID_OPERATION');
const html=(q:MathLesson,s:MathState)=>renderToStaticMarkup(<MathModel lesson={q} state={s} onOperation={()=>{}}/>);

test('b16: both prescribed circles, ordered records and final diameter 3 are required',()=>{
 const q=lesson('math6.b16');let s=initialMathState(q);rejected(q.id,s);
 s=capture(q,set(q,s,{radius:1.5}));rejected(q.id,s); // correct answers + only the second circle
 s=capture(q,set(q,s,{radius:3}));rejected(q.id,s); // reverse order
 s=capture(q,set(q,s,{radius:1.5}));assert.equal(evaluateMath6(rule(q.id),s,answers[q.id]).outcome,'CORRECT');
 assert.deepEqual(s.trials.map(t=>t.values.radius),[1.5,3,1.5]);
 assert.equal(new Map(mathReadout(q,s.values)).get('直径'),'3厘米');
 const rendered=html(q,s);assert.match(rendered,/role="spinbutton"/);assert.match(rendered,/半径 \/ 厘米/);assert.match(rendered,/r="33"/);
 const emptyConstruction={...rule(q.id),math:{...rule(q.id).math!,construction:{}}};rejected(q.id,capture(q,initialMathState(q)),emptyConstruction);
 const wrongFinal=set(q,s,{radius:2});rejected(q.id,wrongFinal);
});

test('u7-05: two views share one non-origin coordinate and preserve both records',()=>{
 const q=lesson('math6.u7-05');let s={...initialMathState(q),observation:'合成位置(3,4)，两种表示共用原点和单位。'};
 s=capture(q,s);rejected(q.id,s);
 const different=capture(q,set(q,s,{col:4,positionView:1}));rejected(q.id,different);
 s=capture(q,set(q,s,{positionView:1}));const result=evaluateMath6(rule(q.id),s,answers[q.id]);
 assert.equal(result.outcome,'UNSCORABLE');assert.equal(result.feedback.assessmentMode?.mode,'OBSERVATION_RECORDED');assert.equal(result.feedback.scenarioMet,true);
 assert.deepEqual(positionFromGrid(3,4).distance,5);assert.ok(Math.abs(positionFromGrid(3,4).angle!-36.8698976458)<1e-9);
 const rows=new Map(mathReadout(q,s.values));assert.equal(rows.get('同一位置的数对'),'（3，4）');assert.equal(rows.get('同一位置的距离（近似）'),'5图示单位');
 assert.match(html(q,s),/同一位置\(3,4\)的方向与距离/);
 const origin=capture(q,set(q,capture(q,set(q,initialMathState(q),{col:0,row:0})),{positionView:1}));rejected(q.id,{...origin,observation:'原点'});
 assert.equal(positionFromGrid(0,0).angle,null);
 assert.equal(applyMathOperation(q,s,{type:'SetMathControl',controlId:'distance',value:5}),null);
});

test('r-04: the existing motion controls now transform a trapezoid, with before/after evidence',()=>{
 const q=lesson('math6.r-04');assert.equal(q.variant,'motion');assert.equal(q.modelShape,'trapezoid');
 let s=capture(q,initialMathState(q));rejected(q.id,s);
 s=capture(q,set(q,s,{sx:2,sy:2}));rejected(q.id,s);
 const wrongAxis=capture(q,set(q,s,{dy:7}));rejected(q.id,wrongAxis);
 s=capture(q,set(q,s,{dx:7}));assert.equal(evaluateMath6(rule(q.id),s,answers[q.id]).outcome,'CORRECT');
 const rows=new Map(mathReadout(q,s.values));assert.equal(rows.get('模型对应底长'),'6格');assert.equal(rows.get('模型对应高度'),'4格');assert.equal(rows.get('变换后面积'),'20平方格');
 assert.match(html(q,s),/底3格高2格梯形/);assert.match(html(q,s),/D′/);
 rejected(q.id,set(q,s,{turn:1}));
 // Regression: r-08 retains its distinct triangle geometry and original controls.
 const triangle=lesson('math6.r-08');const triangleHtml=html(triangle,initialMathState(triangle));assert.match(triangleHtml,/三角形的平移/);assert.doesNotMatch(triangleHtml,/D′/);
});

test('r-07: center (4,3), radius 2 and a quarter sector must exist in the saved and current model',()=>{
 const q=lesson('math6.r-07');let s=capture(q,initialMathState(q));rejected(q.id,s);
 s=set(q,s,{col:4,row:3,radius:2,angle:90});rejected(q.id,s);
 s=capture(q,s);assert.equal(evaluateMath6(rule(q.id),s,answers[q.id]).outcome,'CORRECT');
 assert.match(html(q,s),/圆心\(4,3\)、半径2格、圆心角90度/);
 assert.equal(new Map(mathReadout(q,s.values)).get('扇形占整圆'),'90/360');
 rejected(q.id,set(q,s,{col:3}));rejected(q.id,set(q,s,{assembled:1}));
});

test('u1-11 and b06: public prompt, model scope and quantities agree',()=>{
 const q=lesson('math6.u1-11'),s=capture(q,initialMathState(q)),rows=new Map(mathReadout(q,s.values));
 assert.equal(rows.get('第一个数'),'0.9');assert.equal(rows.get('第二个数'),'0.045');assert.equal(rows.get('包含除的商（近似显示）'),'20');
 assert.equal(evaluateMath6(rule(q.id),s,answers[q.id]).outcome,'CORRECT');rejected(q.id,capture(q,set(q,s,{b:450})));
 const dough=lesson('math6.b06'),markup=html(dough,initialMathState(dough));
 assert.match(dough.challenge,/豆沙∶糯米粉∶草浆=5∶3∶2/);assert.match(dough.modelScope!,/只对应第一问/);assert.match(markup,/糯米粉份数/);assert.match(markup,/草浆份数/);assert.doesNotMatch(markup,/橙汁|纯橙汁|杯水/);
 const a=answer(dough.id,[quantity('q1','300','克'),quantity('q2','200','克'),quantity('q3','250','克')]);assert.equal(evaluateMath6(rule(dough.id),capture(dough,initialMathState(dough)),a).outcome,'CORRECT');
});

test('measurement identity survives snapshots; changing radius cannot silently reuse the old quotient',()=>{
 const q=lesson('math6.b20');let s=capture(q,initialMathState(q));assert.equal(s.values.measuredRadius,7);
 s=set(q,s,{radius:14});const rows=new Map(mathReadout(q,s.values));assert.equal(s.values.measured,4400);assert.equal(s.values.measuredRadius,7);assert.match(rows.get('测量周长与本圆直径比值（近似）')!,/待重新测量/);
 s=capture(q,s);s=set(q,s,{measured:8800});assert.equal(s.values.measuredRadius,14);assert.equal(new Map(mathReadout(q,s.values)).get('测量周长与本圆直径比值（近似）'),'3.1429');
 assert.equal(s.trials[0].values.radius,7);assert.equal(s.trials[0].values.measured,4400);assert.equal(s.trials[1].values.measuredRadius,7);
 assert.equal(mathOperationSchema.safeParse({type:'SetMathControl',controlId:'measuredRadius',value:14}).success,false);
 const old=mathLessonForRelease('rondo.mvp.math6-b20-r1')!,oldState=initialMathState(old);assert.equal(oldState.values.measuredRadius,undefined);assert.match(new Map(mathReadout(old,oldState.values)).get('测量所属半径')!,/未绑定/);
});

test('direct input and button arithmetic share exact range/precision checks, including hundreds-to-one changes',()=>{
 const q=lesson('math6.b16'),control=mathControls(q).find(c=>c.id==='radius')!;
 const direct=parseMathControlInput(control,'1.5');assert.equal(direct,1.5);let stepped=1;for(let i=0;i<5;i++)stepped=nextMathControlValue(control,stepped,1);assert.equal(stepped,direct);
 for(const value of ['1.55','0','6.1','NaN','Infinity','1.5000000000000002','','1e1'])assert.equal(parseMathControlInput(control,value),null,value);
 for(const value of [NaN,Infinity,1.55,0,6.1,1.5000000000000002])assert.equal(applyMathOperation(q,initialMathState(q),{type:'SetMathControl',controlId:'radius',value}),null);
 const place=MATH_LESSONS.find(q=>q.family==='place'&&q.variant!=='base')!,count=mathControls(place).find(c=>c.id==='count')!;
 let s=set(place,initialMathState(place),{count:405});s=set(place,s,{count:parseMathControlInput(count,'3')!});assert.equal(s.values.count,3);
 assert.equal(parseMathControlInput(count,'3.1'),null);assert.equal(parseMathControlInput(count,'1001'),null);
 const golden=MATH_LESSONS.find(q=>q.family==='golden')!,width=mathControls(golden).find(c=>c.id==='width')!;assert.equal(nextMathControlValue(width,62.1,1),62.2);assert.equal(parseMathControlInput(width,'62.22'),null);
 const annulus=lesson('math6.b23');assert.equal(applyMathOperation(annulus,initialMathState(annulus),{type:'SetMathControl',controlId:'inner',value:10}),null);
 const slices=mathControls(q).find(c=>c.id==='slices')!;assert.equal(parseMathControlInput(slices,'12'),null);
});

test('number line labels stay separated for 300/3.5 and 0.9/0.045, with the final extent visible',()=>{
 for(const[a,b]of [[300,3.5],[0.9,0.045],[0,0.03],[0.01,3],[30,0.001]]){
  const axis=decimalAxisMarks(a,b);assert.ok(axis.labels.length<=5);assert.ok(axis.ticks.length<=61);
  assert.equal(axis.labels[0].value,0);assert.equal(axis.labels.at(-1)!.value,Math.max(a,b));
  for(let i=1;i<axis.labels.length;i++)assert.ok(axis.labels[i].x-axis.labels[i-1].x>=89.999,'overlapping labels');
 }
});

test('seven GESP revisions distinguish local answers, whole-premise issues and unverified reasoning text',()=>{
 const expected:Record<string,string>={'202606.tf09':'F','202312.mcq06':'A','202309.tf04':'F','202509.mcq06':'A','202603.mcq15':'A','202609.mcq14':'A','202609.mcq15':'A'};
 for(const[key,correct]of Object.entries(expected)){
  const id='gesp2.'+key,q=GESP_LESSONS.find(q=>q.id===id)!,path='dist/content/'+gespReleaseId(q)+'/private/rules/rule.mvp.activity.v1.json',r=activityRuleSchema.parse(JSON.parse(readFileSync(path,'utf8')).body);
  const state={version:'gesp.state.v1' as const,questionId:id,reasoning:{given:'合成公开前提',steps:'合成过程',check:'合成边界'}};
  const check=(optionId:string)=>evaluateGespObjective(r,state,[{kind:'singleChoice',selectionId:id,optionId}]);
  assert.equal(check(correct).outcome,'CORRECT',key);assert.equal(check(correct==='A'?'B':'T').outcome,'REVISE',key);
  const hasIssue=['202606.tf09','202509.mcq06','202603.mcq15','202609.mcq14','202609.mcq15'].includes(key);
  assert.equal(check('ISSUE').outcome,hasIssue?'UNSCORABLE':'REVISE',key);if(hasIssue){const issue=check('ISSUE');assert.ok(gespIssueRecorded(issue.outcome,issue.feedback));assert.deepEqual(issue.feedback.itemResults,[]);assert.match(issue.feedback.diagnostics![0],/未.*局部填空答对/);}
  const source=renderToStaticMarkup(<GespSource lesson={q}/>);assert.match(source,/先看本次核对范围/);assert.match(source,/原PDF/);
  assert.equal(gespLessonForRelease(gespReleaseId(q).replace(/r2$/,'r1'))?.assessmentScope,undefined);
 }
 const total=GESP_LESSONS.find(q=>q.id==='gesp2.202603.mcq15')!;assert.match(total.assessmentScope!,/总分累加/);assert.match(total.assessmentScope!,/不是求平均分/);
});

test('frozen r1 artifacts remain byte-identical; history resolves a release rather than only a lesson id',()=>{
 for(const[path,expected]of Object.entries(frozenHashes.files))assert.equal(createHash('sha256').update(readFileSync('dist/content/'+path)).digest('hex'),expected,path);
 assert.equal(MATH_LEGACY_LESSONS.length,7);assert.equal(MATH_ACTIVITIES.length,89);
 const old=mathLessonForRelease('rondo.mvp.math6-u1-11-r1')!,current=mathLessonForRelease('rondo.mvp.math6-u1-11-r2')!;
 assert.equal(old.parameters.bDen,undefined);assert.equal(current.parameters.bDen,1000);assert.ok(supersededActivityNotice('rondo.mvp.math6-u1-11-r1'));assert.equal(supersededActivityNotice('rondo.mvp.math6-u1-11-r2'),undefined);
 const markup=renderToStaticMarkup(<MathHistory releaseId="rondo.mvp.math6-u1-11-r1" state={initialMathState(old)}/>);assert.match(markup,/0\.45/);assert.doesNotMatch(markup,/0\.045/);
});
