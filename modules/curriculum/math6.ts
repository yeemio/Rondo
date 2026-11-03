import data from '../../content/math6/public/lessons.json';
import legacy from '../../content/math6/public/lessons-r1.json';
import {mathStateSchema,type MathState,type MathFamily,type MathOperation} from '../contracts/public/math6';
export interface MathQuestion{id:string;label:string;kind:'quantity'|'choice';unit?:string;options?:Array<{id:string;label:string}>}
export interface MathLesson{id:string;placementId:string;top:number;pages:string;title:string;objectives:string[];family:MathFamily;variant:string;parameters:Record<string,number>;mode:'score'|'observe';concept:string;challenge:string;questions:MathQuestion[];explain:string;sourceSha256:string;sourceNote:string;contentVersion?:'r2';modelScope?:string;modelShape?:'trapezoid'}
export const MATH_LESSONS=data as unknown as MathLesson[];
export const MATH_LEGACY_LESSONS=legacy as unknown as MathLesson[];
export const MATH_RELEASE_LESSONS=[...MATH_LESSONS,...MATH_LEGACY_LESSONS];
export const mathReleaseId=(q:MathLesson)=>'rondo.mvp.'+q.id.replaceAll('.','-')+'-'+(q.contentVersion??'r1');
const activity=(q:MathLesson)=>({id:'math6' as const,releaseId:mathReleaseId(q),taskId:q.id+'.v1',title:q.title,domain:'数学' as const,source:q.sourceNote,sourceVersion:q.sourceSha256,prompt:[q.concept,q.challenge,...(q.modelScope?[q.modelScope]:[])],explain:q.explain});
export const MATH_ACTIVITIES=MATH_LESSONS.map(activity);
export const MATH_LEGACY_ACTIVITIES=MATH_LEGACY_LESSONS.map(activity);
export const MATH_REGISTERED_ACTIVITIES=[...MATH_ACTIVITIES,...MATH_LEGACY_ACTIVITIES];
export function mathLessonForRelease(releaseId:string,taskId?:string):MathLesson|undefined{return MATH_RELEASE_LESSONS.find(q=>mathReleaseId(q)===releaseId&&(!taskId||q.id+'.v1'===taskId));}
export interface MathControl{id:string;label:string;min:number;max:number;step:number;initial:number;options?:Array<{value:number;label:string}>}
const c=(id:string,label:string,min:number,max:number,step=1,initial=min):MathControl=>({id,label,min,max,step,initial});
export function mathControls(q:MathLesson):MathControl[]{
 let list:MathControl[]=[];
 if(q.family==='decimal')list=[c('a','第一个数的1/100单位个数',0,Math.max(3000,q.parameters.a??0),1,60),c('b',`第二个数的1/${q.parameters.bDen??100}单位个数`,1,Math.max(3000,q.parameters.b??0),1,40)];
 if(q.family==='relation')list=q.variant==='work'?[c('first','第一人单独完成小时/天数',1,40,1,6),c('second','第二人单独完成小时/天数',1,40,1,3),c('elapsed','合作经过的时间',0,12,1,1)]:[c('total','整体数量',1,1000,1,45),c('den','整体平均份数',1,100,1,9),c('part','取出的份数',0,100,1,5)];
 if(q.family==='billing')list=q.variant==='water'?[c('usage','合成用水量 / 立方米',0,40,1,17),c('threshold','第一阶梯门槛 / 立方米',1,30,1,15)]:[c('minutes','停车时间 / 分钟',0,300,1,121)];
 if(q.family==='place')list=q.variant==='base'?[{...c('base','进制',2,10,1,2),options:[2,5,8,10].map(value=>({value,label:value+'进制'}))},c('digits','不变的十进制数量',0,127,1,9)]:[c('count','计数单位的个数',0,1000,1,336),{...c('denominator','一个计数单位',1,1000,1,100),options:[1,10,20,100,1000].map(value=>({value,label:'1/'+value}))}];
 if(q.family==='ratio')list=[c('first',q.variant==='dough'?'糯米粉份数（第一问）':'第一部分份数',1,20,1,3),c('second',q.variant==='dough'?'草浆份数（第一问）':'第二部分份数',1,20,1,2),c('scale','共同扩大倍数',1,4,1,1)];
 if(q.family==='golden')list=[c('width','固定长100时的宽',20,95,0.1,62),c('step','斐波那契数列观察项数',3,12,1,7)];
 if(q.family==='circle')list=[...(q.variant==='coordinate-sector'?[c('col','圆心横坐标 / 格',-10,10,1,0),c('row','圆心纵坐标 / 格',-10,10,1,0)]:[]),...(q.variant==='perimeter'?[c('measured','合成测量周长读数 / 百分之一单位',1,10000,1,4400),c('roll','圆滚动的四分之一圈数',0,4,1,0)]:[]),q.id==='math6.b16'&&q.contentVersion==='r2'?c('radius','半径 / 厘米',0.1,6,0.1,1):c('radius','外圆半径 / 单位长',1,15,1,4),...(q.variant==='annulus'?[c('inner','内圆半径 / 单位长',0,14,1,2)]:[]),c('angle','圆心角 / 度',30,360,30,90),c('slices','切拼等分份数',8,64,8,8),{...c('assembled','圆与切拼',0,1,1,0),options:[{value:0,label:'保持圆形'},{value:1,label:'观察交错切拼'}]}];
 if(q.family==='scale')list=q.variant==='map'?[c('mapCm','图上距离 / 厘米',1,10,1,5),{...c('denominator','比例尺1∶n的n',1000,1000000,1,1000),options:[1000,2000,5000,8000,1000000].map(value=>({value,label:'1∶'+value}))}]:[c('sx','横向分子',1,6,1,1),c('sy','纵向分子',1,6,1,1),c('divisor','共同分母',1,3,1,1),...(q.variant==='motion'?[c('dx','横向平移格数',-7,7,1,0),c('dy','纵向平移格数',-7,7,1,0),c('turn','顺时针旋转90°的次数',0,3,1,0),{...c('mirror','关于纵轴对称',0,1,1,0),options:[{value:0,label:'保持原侧'},{value:1,label:'作轴对称'}]}]:[])];
 if(q.family==='position')list=q.variant==='grid'||q.variant==='dual'?[c('col','列（先读，向东）',0,10,1,3),c('row','行（后读，向北）',0,10,1,4),...(q.variant==='dual'?[{...c('positionView','同一位置的表示方法',0,1,1,0),options:[{value:0,label:'方格数对'},{value:1,label:'方向与距离'}]}]:[])]:[{...c('quadrant','从哪个方向偏向哪边',0,3,1,0),options:['北偏东','北偏西','南偏东','南偏西'].map((label,value)=>({label,value}))},c('angle','偏角 / 度',0,90,5,30),c('distance','距离 / 图示单位',1,40,1,20)];
 return list.map(x=>({...x,initial:q.parameters[x.id]??x.initial}));
}
export function initialMathState(q:MathLesson):MathState{const values=Object.fromEntries(mathControls(q).map(x=>[x.id,x.initial]));if(q.variant==='perimeter'&&q.contentVersion==='r2')values.measuredRadius=values.radius;return mathStateSchema.parse({version:'math.state.v1',lessonId:q.id,family:q.family,values,trials:[],observation:''});}
// Registered tenths use integer arithmetic. Never silently round illegal precision.
function tenths(value:number):number|null{const text=String(value);if(!/^-?\d+(?:\.\d)?$/.test(text))return null;return Number(text.replace('.',''))*(text.includes('.')?1:10);}
export function validMathControlValue(control:MathControl,value:number):boolean{
 if(!Number.isFinite(value)||value<control.min||value>control.max||control.options&&!control.options.some(x=>x.value===value))return false;
 if(control.step===0.1){const n=tenths(value),min=tenths(control.min);return n!==null&&min!==null&&(n-min)%Math.round(control.step*10)===0;}
 return (value-control.min)%control.step===0;
}
export function parseMathControlInput(control:MathControl,text:string):number|null{if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text.trim()))return null;const value=Number(text);return validMathControlValue(control,value)?value:null;}
export function nextMathControlValue(control:MathControl,value:number,direction:-1|1):number{return control.step===0.1?(Math.round(value*10)+direction)/10:value+direction*control.step;}
export function positionFromGrid(col:number,row:number):{distance:number;angle:number|null}{return{distance:Math.hypot(col,row),angle:col===0&&row===0?null:Math.atan2(col,row)*180/Math.PI};}
export function applyMathOperation(q:MathLesson,state:MathState,op:MathOperation):MathState|null{
 if(state.lessonId!==q.id||state.family!==q.family)return null;
 if(op.type==='CaptureMathTrial')return state.trials.length>=12?null:{...state,trials:[...state.trials,{values:{...state.values}}]};
 if(op.type==='RecordMathObservation')return{...state,observation:op.text};
 const control=mathControls(q).find(x=>x.id===op.controlId);if(!control||!validMathControlValue(control,op.value))return null;
 if(q.family==='circle'&&(op.controlId==='inner'&&op.value>=state.values.radius||op.controlId==='radius'&&state.values.inner!==undefined&&op.value<=state.values.inner))return null;
 return{...state,values:{...state.values,[op.controlId]:op.value,...(q.variant==='perimeter'&&q.contentVersion==='r2'&&op.controlId==='measured'?{measuredRadius:state.values.radius}:{})}};
}
