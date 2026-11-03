export function StudioNav({active,onSelect}:{active:number;onSelect:(index:number)=>void}) {
 const subjects=[['数学','换一份配方，比没有变'],['GESP 编程','让字母，一行一行长大'],['AI 通识','把好听的话，放在证据旁']];
 return <nav className="subject-nav" aria-label="学习领域">{subjects.map(([title,subtitle],i)=><button key={title} className={'subject-tab'+(active===i?' active':'')} aria-pressed={active===i} onClick={()=>onSelect(i)}><span className={'subject-symbol '+['math-symbol','code-symbol','ai-symbol'][i]} aria-hidden="true">{i===1?'{ }':i===2?<><i/><i/><i/></>:null}</span><span><strong>{title}</strong><small>{subtitle}</small></span></button>)}</nav>;
}
export function LearningSteps({phase}:{phase:string}){const active=phase==='PREDICT'?0:phase==='OPERATE'?1:2;return <nav className="lesson-steps" aria-label="本次探索步骤">{['先猜','动手','发现'].map((s,i)=><span key={s} className={active===i?'active':''} aria-current={active===i?'step':undefined}><em>{i+1}</em>{s}</span>)}</nav>;}
