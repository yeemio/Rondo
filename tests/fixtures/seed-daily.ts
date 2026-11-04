/** Local Terra scene: controlled ServerClock, actual commands, fake compiler, and a closed SQLite file. */
import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Harness} from './harness';
import {dailyDriver,dailyPolicy,loadDailyReleases,noRunCompiler} from './daily';
import type {DailyItemView} from '../../modules/contracts/public/daily';

async function seed(){
  const root=process.env.RONDO_DAILY_FIXTURE_ROOT,scenario=process.env.RONDO_DAILY_FIXTURE_SCENARIO;
  const passphrase=process.env.RONDO_SYNTH_PASSPHRASE;
  if(!root||!scenario||!passphrase||passphrase.length<8)throw Error('Missing synthetic seed configuration.');
  // Exclusive creation refuses any existing directory, including an empty real data root.
  await mkdir(root);await mkdir(join(root,'learning'));await mkdir(join(root,'technical'));
  const h=await Harness.create({dbFile:join(root,'learning','learning.sqlite'),contentRoot:join(root,'technical','synthetic-content'),policy:dailyPolicy(),compiler:noRunCompiler(),hostEpoch:'synthetic-seed-closed-before-host'});
  let learnerId='',setId='',date='';
  try{
    // Yesterday in the server's own calendar. Real Host startup uses its normal current clock.
    h.clock.advance(Date.now()-86400000-h.clock.now());await loadDailyReleases(h,[],resolve('dist/content'));
    const family=await h.auth.setupGuardian({idempotencyKey:h.setupKey,familyDisplayName:'每日练习·仅合成验收',guardianDisplayName:'合成监护人',passphrase});
    h.familyId=family.familyId;h.guardianActorId=family.actorId;
    learnerId=await h.createLearner(await h.guardianContext(),'合成六年级学生');await h.enterLearner(learnerId);
    const d=dailyDriver(h,learnerId);
    if(scenario!=='fresh'){
      let set=await d.start(scenario==='gesp'?'gesp':'math');setId=set.setId;date=set.date;
      const first=set.items[0],id=first.attemptId!;
      const wrong=first.lessonId.startsWith('math6.')?[{kind:'mathAnswer' as const,version:'math.answers.v1' as const,lessonId:first.lessonId,answers:[{kind:'quantity' as const,id:'q1',value:{kind:'decimal' as const,value:'0.24'},unit:'unitless'}]}]:[{kind:'singleChoice' as const,selectionId:first.lessonId,optionId:'A'}];
      await d.save(id,{answerText:JSON.stringify(scenario==='gesp'?{gespChoice:'A'}:{q1:'0.24'})});await d.answer(first,wrong);await d.send('learning.reviseResponse',{},id);
      if(scenario==='yesterday'||scenario==='gesp'){
        // A real draft, not a submitted correction. Terra chooses and submits the next answer.
        await d.save(id,{answerText:JSON.stringify(scenario==='gesp'?{gespChoice:'B'}:{q1:'0.024'})});await d.send('learning.pauseAttempt',{},id);
      }else{
        await d.send('learning.requestHint',{hintLevel:1},id);await d.answer(first);await d.advance(setId,0);
        for(let i=1;i<5;i++){set=(await d.daily(setId)).set!;await d.answer(set.items[i]);await d.advance(setId,i);}
        const circle=(await d.daily(setId)).set!.items[5] as DailyItemView;
        if(scenario==='model')await d.send('learning.pauseAttempt',{},circle.attemptId!);
        else{await d.model(circle);await d.answer(circle);await d.explain(circle);await d.advance(setId,5);}
      }
    }
    await h.auth.lock();
    console.log(JSON.stringify({syntheticOnly:true,scenario,learner:'合成六年级学生',learnerId,setId:setId||null,groupDate:date||null,stopAt:scenario==='fresh'?'首页尚无题组':scenario==='summary'?'昨天六题已结束；今天可开始下一组':scenario==='model'?'昨天第6题，尚未提交猜想与模型操作':'昨天第1题，保留错误尝试和未提交修改；当前已暂停',login:'Use the synthetic guardian passphrase supplied through RONDO_SYNTH_PASSPHRASE; then enter 合成六年级学生.',clock:'Only the fixture ServerClock was changed. Host uses its normal clock.',database:'learning/learning.sqlite'},null,2));
  }finally{await h.closeAll();}
  console.log('Synthetic SQLite closed. Stop here; open this data root with the normal local Host. No compiler was invoked.');
}
await seed().catch(error=>{console.error(error?.code==='EEXIST'?'REFUSED: target directory already exists; no existing root was opened.':'Synthetic seed failed; do not reuse its partial directory. '+String(error?.code??'CHECK_FAILED'));process.exitCode=1;});
