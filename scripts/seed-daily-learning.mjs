#!/usr/bin/env node
/** Creates a NEW synthetic data root only. No product flags, OS clock change, or containers. */
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),allowed=new Set(['yesterday','model','summary','gesp','fresh']);
if(args.length!==4||args[0]!=='--root'||args[2]!=='--scenario'||!allowed.has(args[3])){
  console.error('Usage: node scripts/seed-daily-learning.mjs --root NEW_DIRECTORY --scenario yesterday|model|summary|gesp|fresh');process.exit(2);
}
if((process.env.RONDO_SYNTH_PASSPHRASE??'').length<8){console.error('Set RONDO_SYNTH_PASSPHRASE to a new synthetic-only passphrase of at least 8 characters. It is never printed.');process.exit(2);}
const bundle=await build({entryPoints:[resolve(repo,'tests/fixtures/seed-daily.ts')],bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.sql':'text'},write:false,logLevel:'warning'});
const child=spawnSync(process.execPath,['--input-type=module'],{cwd:repo,input:bundle.outputFiles[0].text,encoding:'utf8',stdio:['pipe','inherit','inherit'],env:{...process.env,RONDO_DAILY_FIXTURE_ROOT:resolve(args[1]),RONDO_DAILY_FIXTURE_SCENARIO:args[3]}});
if(child.error){console.error('Synthetic seed process could not start.');process.exit(1);}process.exit(child.status??1);
