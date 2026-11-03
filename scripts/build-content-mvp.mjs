import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const compiled=await build({entryPoints:[join(root,'modules/curriculum/mvp.ts')],bundle:true,write:false,format:'esm',platform:'node'});
const {MVP_ACTIVITIES,CPP_STARTER}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const canon=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canon).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
const write=(dir,file,data)=>{mkdirSync(resolve(dir,file,'..'),{recursive:true});writeFileSync(join(dir,file),JSON.stringify(data,null,2)+'\n');};
for(const a of MVP_ACTIVITIES){
 const dir=join(process.env.RONDO_DIST_DIR??join(root,'dist'),'content',a.releaseId), ruleId='rule.mvp.activity.v1';
 const ops=['SaveActivityDraft',...(a.id==='ratio'?['SetActivityScale']:['InspectActivityCard'])];
 const task={taskId:a.taskId,taskVersion:'1',taskFamily:'mvp.activity.v1',title:a.title,promptGroups:[{minVisibility:'PREDICTION',blocks:[...a.prompt,{type:'TEXT',text:'来源：'+a.source}].map(x=>typeof x==='string'?{type:'TEXT',text:x}:x)}],responseSchemaId:'resp.mvp.activity.v1',allowedOperationIds:ops,givens:{activity:a.id,scale:1,inspected:[],draft:{prediction:'',answerText:'{}',explanation:'',source:a.id==='cpp'?CPP_STARTER:'',stdin:a.id==='cpp'?'3\n':''}}};
 const header={releaseId:a.releaseId,taskIds:[a.taskId],taskVersion:'1',rendererDeclarations:[{rendererId:'rondo.activity',rendererContractVersion:'1',publicStateSchemaVersion:'1'}],publicAssetHashes:[],expressionOperationSubsets:['BOARD_SVG','BOARD_TABLE'].map(expression=>({expression,allowedOperationIds:ops}))};
 const truth={kind:'MVP_ACTIVITY_TRUTH_V1',activity:a.id,choices:a.id==='ai-a7'?{hours:'conflict',animals:'conflict',bus:'insufficient'}:{},privateInputs:a.id==='cpp'?[2,7,40]:[],referenceSource:a.id==='cpp'?'#include <iostream>\nusing namespace std;\nint main() {\n int n; cin >> n; int ch = 0;\n for (int i=1; i<=n; i++) {\n  for (int j=1; j<=i; j++) cout << (char)("A"[0] + (ch++) % 26);\n  cout << endl;\n }\n return 0;\n}\n':'',explanation:a.id==='ratio'?'橙汁与水是3∶2，橙汁占整份饮料的3/5；两种量同时乘相同倍数，比不变。':a.id==='cpp'?'用一个跨行计数器记录已输出字母数。外层决定行，内层输出该行字母；以26为周期循环字母。每行结束换行，不追加空格。':'每天开放与周一闭园冲突；可以喂鹿与请勿投喂冲突；资料未给出公交线路，因此7路是否能到仍待核查。'};
 write(dir,'public/tasks/'+a.taskId+'.json',task);
 write(dir,'private/rules/'+ruleId+'.json',{ruleId,body:truth});
 write(dir,'private/bindings.json',{releaseId:a.releaseId,taskBindings:[{taskId:a.taskId,ruleRef:{ruleId,ruleVersion:'1',path:'rules/'+ruleId+'.json'}}]});
 write(dir,'manifest.json',{public:{...header,publicManifestHash:createHash('sha256').update(canon({publicHeader:header,tasks:{[a.taskId]:task},hints:{},assets:{}})).digest('hex')},private:{ruleRefs:[{taskId:a.taskId,ruleId,ruleVersion:'1'}],hintGateTable:[],constructionParamDomains:[]}});
}
console.log('MVP: 3 representative activities; full scope remains 12 mathematics entries / 15 GESP papers / 8 AI units.');
