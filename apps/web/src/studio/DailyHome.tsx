import type {DailyProjection,DailySetView,DailyScope} from '../../../../modules/contracts/public/daily';

export const dailyResultText={NOT_CHECKED:'尚未核对',CORRECT:'核对正确',CORRECTED:'纠正后通过',REVIEW:'尚待复练',OBSERVED:'观察已记录'} as const;
export function DailyProgress({set}: {set:DailySetView}){
  return <ol className="daily-progress" aria-label="本组题目顺序">{set.items.map((item,i)=><li key={item.poolId} aria-current={set.status==='OPEN'&&set.currentIndex===i?'step':undefined}>
    <span className="daily-step-number">{i+1}</span><div><strong>{item.title}</strong><small>{item.state==='QUEUED'?'还没开始':item.state==='MISSING'?'原记录已移除':item.state==='PAUSED'?'已暂停':dailyResultText[item.result]}</small></div>
  </li>)}</ol>;
}
export function DailyHomeCard({value,loadError,scope,disabled,activeOther,onStart,onOpen,onReload}:{
  value:DailyProjection|null;loadError?:string;scope:DailyScope;disabled:boolean;activeOther:boolean;
  onStart:(scope:DailyScope,mode:'today'|'practice',previousSetId?:string)=>void;onOpen:(setId:string)=>void;onReload:()=>void;
}){
  const set=value?.set,unfinished=set?.status==='OPEN',sameDay=set?.date===value?.serverDate,shownScope=unfinished?set.scope:scope;
  const action=unfinished?'继续上次练习':sameDay&&set?.status==='COMPLETE'?'看看本组小结':'开始今天的练习';
  return <section className="daily-home" aria-labelledby="daily-home-title">
    <div><p className="daily-eyebrow">每天一小组 · 数学或 GESP 客观题</p><h1 id="daily-home-title">{unfinished?'接着上次，继续往前。':'先从一小组开始。'}</h1>
      <p className="intro">{unfinished?`${set.date} 的${set.scope==='math'?'数学':'GESP客观题'}练习还在，第 ${set.currentIndex+1} / 6 题等你继续。`:`这次选择${scope==='math'?'数学':'GESP客观题'}，共6题。读题、作答、看反馈，错了可以再试一次。`}</p>
      <p>{shownScope==='math'?'数学短题直接核对回答；圆的比较要亲手操作、留下记录并说明依据。':'这一组只练条件明确的客观题。完整 C++ 编程和 AI 活动保留在课程入口。'}</p>
      {!value?<><p role="status">{loadError||'正在找回原来的练习…'}</p><button className="text-button" onClick={onReload}>重新读取</button></>:set?.status==='UNAVAILABLE'?<>
        <p role="status">本组当前需要的记录已移除或暂不可用，不能当成完成。原来仍在的回答可以继续回看。</p>
        <button className="primary-button" disabled={disabled} onClick={()=>onStart(scope,'practice',set.setId)}>{activeOther?'暂停当前活动，另开复练':'另开一组复练'} →</button>
      </>:<button className="primary-button" disabled={disabled} onClick={()=>sameDay&&set?.status==='COMPLETE'?onOpen(set.setId):onStart(scope,'today')}>
        {activeOther&&!(sameDay&&set?.status==='COMPLETE')?'暂停当前活动，':''}{action} →
      </button>}
      {set?.status==='COMPLETE'?<><p>这一组已结束；小结分别保留核对正确、纠正后通过和待复练的项目。结束题组不代表掌握。</p>
        <button className="secondary-button" disabled={disabled} onClick={()=>onStart(set.scope,'practice',set.setId)}>{activeOther?'暂停当前活动，再练一组':'再练一组'} →</button>
        {!sameDay?<button className="text-button" onClick={()=>onOpen(set.setId)}>回看上次小结</button>:null}
      </>:null}
      {activeOther?<p className="footnote">进入练习前会暂停当前活动并保留已保存的记录。</p>:null}
      <p className="footnote">日期按北京时间计算；昨天没做完的练习仍先继续。</p>
    </div>
    <aside className="daily-home-note"><h2>{unfinished?'这组顺序已经留好':'这次怎样安排'}</h2><p>优先再练有修正或提示记录的题，再接同类基础题。没有记录时，从已选定的小题池开始。</p><p>这是一组固定的基础练习。刷新或重新打开，会继续原组。</p>
      {set?<details><summary>看看这组题目与安排理由</summary><DailyProgress set={set}/>{set.items.map(item=><p key={item.poolId}><strong>{item.title}</strong>：{item.reason}</p>)}</details>:null}
    </aside>
  </section>;
}
export function DailySummary({set,onHome,onPractice,disabled}:{set:DailySetView;onHome:()=>void;onPractice:()=>void;disabled:boolean}){
  const counts=(result:string)=>set.items.filter(item=>item.state!=='MISSING'&&item.result===result).length;
  return <section className="daily-summary" aria-labelledby="daily-summary-title"><p className="daily-eyebrow">{set.date} · {set.scope==='math'?'数学':'GESP客观题'} · 6题</p>
    <h1 id="daily-summary-title" tabIndex={-1}>这组练习，留好小结了。</h1><p>只记录这次发生的事，不把一次答对或结束题组说成掌握。</p>
    <dl className="daily-counts">{(['CORRECT','CORRECTED','REVIEW','OBSERVED'] as const).map(result=><div key={result}><dt>{dailyResultText[result]}</dt><dd>{counts(result)}</dd></div>)}<div><dt>请求提示</dt><dd>{set.items.reduce((n,item)=>n+item.hintCount,0)}次</dd></div><div><dt>请求解析</dt><dd>{set.items.filter(item=>item.explanationRequested).length}题</dd></div></dl>
    {set.items.some(item=>item.state==='MISSING')?<p role="note">部分原记录已按既有数据规则移除，不再显示其核对结果，也不补算为通过。</p>:null}
    <DailyProgress set={set}/><p>{counts('REVIEW')?'还有题值得再练。下一组会优先安排这些题。':counts('CORRECTED')?'这次有纠正后的进步。下一组可以再核对一次。':'可以休息一下，或明确选择再练一组；之前的回答一直分开保留。'}</p>
    <div className="daily-actions"><button className="primary-button" disabled={disabled} onClick={onPractice}>再练一组 →</button><button className="secondary-button" disabled={disabled} onClick={onHome}>回到学习首页</button></div>
  </section>;
}
