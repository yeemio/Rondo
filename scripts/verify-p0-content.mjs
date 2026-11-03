/** Focused task-A checks. Optional --baseline supplies the unchanged e0015f9 rondo source. */
import {build} from 'esbuild';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),out=join(root,'.p0-checks');mkdirSync(out,{recursive:true});
const baseFlag=process.argv.indexOf('--baseline'),baseline=baseFlag<0?undefined:resolve(process.argv[baseFlag+1]);
const env={...process.env};
if(!baseline)console.log('NOT_RUN: original-baseline upgrade scenario requires --baseline; the test will be explicitly skipped.');
for(const name of ['math6','gesp']){
 const run=spawnSync(process.execPath,['scripts/build-content-'+name+'.mjs'],{cwd:root,env,encoding:'utf8'});process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');if(run.status!==0)process.exit(run.status??1);
}
if(baseline){await build({entryPoints:[join(baseline,'tests/fixtures/harness.ts')],bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.sql':'text'},outfile:join(out,'baseline-harness.mjs'),logLevel:'warning'});env.RONDO_P0_BASELINE_HARNESS=join(out,'baseline-harness.mjs');}
await build({entryPoints:['tests/mvp/p0-content.test.tsx','tests/mvp/p0-content-integration.test.tsx'].map(p=>join(root,p)),bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',loader:{'.sql':'text'},outdir:out,outExtension:{'.js':'.mjs'},logLevel:'warning'});
const run=spawnSync(process.execPath,['--test',join(out,'p0-content.test.mjs'),join(out,'p0-content-integration.test.mjs')],{cwd:root,env,encoding:'utf8'});
writeFileSync(join(out,'focused-tests.log'),(run.stdout??'')+(run.stderr??'')+'\nEXIT_CODE='+(run.status??1)+'\n');process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');if(run.status!==0)process.exit(run.status??1);
const browser=await build({entryPoints:[join(root,'apps/web/src/main.tsx')],bundle:true,write:false,platform:'browser',target:'es2022',format:'iife',jsx:'automatic',metafile:true,define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',outfile:join(out,'boundary-app.js')});
const inputs=Object.keys(browser.metafile.inputs),privateInputs=inputs.filter(p=>/content\/[^/]+\/private\/|modules\/learning\/|modules\/contracts\/server\//.test(p));
const js=browser.outputFiles.find(f=>f.path.endsWith('.js')).text,privateRuleMarkers=['semanticAnswers','modelEvidence','acceptedAnswers','choiceFeedback'].filter(marker=>js.includes(marker));
const boundary={status:privateInputs.length||privateRuleMarkers.length?'FAIL':'PASS',inputCount:inputs.length,privateInputs,privateRuleMarkers};
writeFileSync(join(out,'public-boundary.json'),JSON.stringify(boundary,null,2)+'\n');console.log(JSON.stringify(boundary));if(boundary.status!=='PASS')process.exit(1);

