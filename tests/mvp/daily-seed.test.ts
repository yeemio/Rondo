import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Harness} from '../fixtures/harness';
import {dailyDriver,dailyPolicy,loadDailyReleases,noRunCompiler} from '../fixtures/daily';
import {dailyDate} from '../../modules/learning/daily';
import type {ActivityState} from '../../modules/contracts/public/activity';

test('real seed entrypoint creates yesterday scene, closes SQLite, accepts normal auth on reopen, and refuses an existing root',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'rondo-seed-entry-')),root=join(parent,'new-synthetic'),passphrase='synthetic-'+randomUUID();
  let h:Harness|undefined;
  try{
    const run=()=>execFileSync(process.execPath,['scripts/seed-daily-learning.mjs','--root',root,'--scenario','yesterday'],{cwd:resolve('.'),env:{...process.env,RONDO_SYNTH_PASSPHRASE:passphrase},encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const output=run();assert.ok(output.includes('Synthetic SQLite closed'));assert.equal(output.includes(passphrase),false);
    const metadata=JSON.parse(output.slice(0,output.indexOf('\nSynthetic SQLite closed')));assert.equal(metadata.syntheticOnly,true);
    const db=join(root,'learning','learning.sqlite'),hash=()=>readFile(db).then(b=>createHash('sha256').update(b).digest('hex')),before=await hash();
    assert.throws(run,e=>String((e as {stderr:unknown}).stderr).includes('REFUSED: target directory already exists'));assert.equal(await hash(),before);
    h=await Harness.create({dbFile:db,contentRoot:join(root,'technical','synthetic-content'),policy:dailyPolicy(),compiler:noRunCompiler(),hostEpoch:'ordinary-reopen-current-time'});
    h.clock.advance(Date.now()-h.clock.now());await loadDailyReleases(h);assert.equal(await h.auth.session(),null);
    await h.auth.unlockGuardian({passphrase});await h.enterLearner(metadata.learnerId);const d=dailyDriver(h,metadata.learnerId),projection=await d.daily();
    assert.equal(projection.serverDate,dailyDate(Date.now()));assert.equal(projection.set!.date,dailyDate(Date.now()-86400000));assert.equal(projection.set!.setId,metadata.setId);assert.equal(projection.set!.items[0].state,'PAUSED');
    const history=await d.history();assert.equal(history.attempts[0].cycles[0].submissions[0].outcome,'REVISE');assert.equal(history.attempts[0].cycles[0].submissions.length,1);
    const q=await d.question(metadata.setId);assert.equal((q.scene.state as ActivityState).draft.answerText,'{"q1":"0.024"}');assert.equal((await d.start('gesp')).setId,metadata.setId);
  }finally{await h?.closeAll();await rm(parent,{recursive:true,force:true});}
});
