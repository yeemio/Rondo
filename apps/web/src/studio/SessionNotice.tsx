import {useEffect,useMemo,useState} from 'react';
import type {AppPorts} from '../client/ports';
import {SessionCommands,type LearningIdentity} from './session-recovery';
const friendlyError=(text:string)=>text.includes('VERSION_CONFLICT')?'刚才的记录有了变化，请重新读取活动后再试。':text.includes('INVALID_OPERATION')?'这一步还不能继续。请确认当前活动和已保存的回答，再试一次。':text.includes('FORBIDDEN')?'这份记录不属于当前学习者，请回到学习首页。':text.includes('HOST_RECOVERING')?'编程环境或原请求还没有确认；请保留代码，按原请求确认后再继续。':text.includes('CAPABILITY_UNAVAILABLE')?'编程环境暂时没有准备好，可以先理解步骤，稍后再运行。':text.includes('claims must')||text.includes('schema')||text.includes('Schema')?'刚才的内容没有成功保存，请检查输入后重试。':'刚才没有完成保存，请保留当前内容，再确认一次。';
export function useMvpCommand(ports:AppPorts,identity:LearningIdentity){
 const controller=useMemo(()=>new SessionCommands(ports,identity,localStorage),[ports,identity.familyId,identity.learnerId]);
 const [state,setState]=useState(controller.getSnapshot);
 useEffect(()=>{setState(controller.getSnapshot());return controller.subscribe(setState);},[controller]);
 return {...state,getSnapshot:controller.getSnapshot,send:controller.send,retry:controller.retry,reenterAndRetry:controller.reenterAndRetry,reportFailure:controller.reportFailure};
}
export function CommandNotice({command,onRetry,onRecovered}:{command:ReturnType<typeof useMvpCommand>;onRetry:()=>void;onRecovered:()=>void}){
 const [passphrase,setPassphrase]=useState('');
 const pendingRun=command.pending?.kind==='code.requestRun';
 return <div className="save-notice" role="status">{command.busy?<p>{pendingRun?'正在确认运行请求…':'正在保存…'}</p>:null}
 {command.needsReentry?<section className="session-recovery" aria-label="重新进入并保留编辑"><h3>先重新进入，想法还在这里。</h3><p>这次学习的进入时间已到。当前页面没有离开，编辑和刚才的请求仍保留；请监护人解锁后继续。</p>{pendingRun?<p>重新进入只恢复学习身份，不会解除编程环境的未确认保护。</p>:null}<form onSubmit={e=>{e.preventDefault();const secret=passphrase;setPassphrase('');void command.reenterAndRetry(secret).then(result=>{if(result.reentered)onRecovered();});}}><label>监护口令<input type="password" autoComplete="off" value={passphrase} onChange={e=>setPassphrase(e.target.value)} required disabled={command.recovering}/></label><button type="submit" className="primary-button" disabled={command.recovering||!passphrase}>{command.recovering?'正在重新进入…':command.pending?pendingRun?'重新进入并确认原运行请求':'重新进入并确认刚才的保存':'重新进入，继续这次探索'}</button></form>{command.recoveryError?<p className="form-recovery" role="alert">{command.recoveryError} 当前编辑和待确认的请求没有清除。</p>:null}</section>:command.error&&!command.recoveryNote?<><p className="form-recovery">{command.errorCode==='FORBIDDEN'?command.error:friendlyError(command.errorCode+' '+command.error)}</p><details className="technical-note"><summary>查看诊断详情</summary><pre>{command.error}</pre></details></>:null}
 {command.pending&&!command.busy&&!command.needsReentry?<p>{pendingRun?'运行请求还没有确认，尚不能判断它是否执行。原代码与编辑仍保留。':'刚才的保存还没有确认。'}<button className="text-button" disabled={command.recovering} onClick={onRetry}>{pendingRun?'确认原运行请求':'确认刚才的保存'}</button></p>:null}
 {command.recoveryNote?<p className="session-recovered">{command.recoveryNote}</p>:null}</div>;
}
