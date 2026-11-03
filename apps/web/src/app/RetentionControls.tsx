import { useEffect, useState } from 'react';
import type { AppPorts } from '../client/ports';
import { restorePendingRetention, saveReviewedRetention } from '../client/retention-flow';
import type { PendingRetention, RetentionPreview, RetentionState } from '../client/retention-flow';

const date = (ms: number) => new Date(ms).toLocaleString('zh-CN');
const statusLabel: Record<string, string> = { COMPLETED: '已完成', ABANDONED: '已结束未完成', CONTENT_BLOCKED: '内容不可用', ACTIVE: '进行中', PAUSED: '暂停' };

export function RetentionControls({ ports, familyId, busy, setBusy }: {
  ports: AppPorts; familyId: string; busy: boolean; setBusy: (value: boolean) => void;
}) {
  const key = `rondo.retention.pending.${familyId}`;
  const [pending, setPending] = useState<PendingRetention | null>(() => { try { return restorePendingRetention(sessionStorage.getItem(key)); } catch { return null; } });
  const [saved, setSaved] = useState<RetentionState | null>(null);
  const [mode, setMode] = useState<RetentionPreview['mode'] | null>(pending?.intent.mode ?? null);
  const [days, setDays] = useState(pending?.intent.rollingDays?.toString() ?? '');
  const [review, setReview] = useState<RetentionPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('正在读取已存政策…');
  const remember = (value: PendingRetention | null) => {
    setPending(value);
    try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* Same-page recovery still retains the original key. */ }
  };
  const readPolicy = async () => {
    const state = await ports.client.query({ kind: 'guardian.retentionPolicy' });
    if (state.kind !== 'guardian.retentionPolicy') throw new Error('保留政策读取暂不可用。');
    setSaved(state);
    return state;
  };
  useEffect(() => {
    let active = true;
    void ports.client.query({ kind: 'guardian.retentionPolicy' }).then((state) => {
      if (!active || state.kind !== 'guardian.retentionPolicy') return;
      setSaved(state);
      if (!pending) { setMode(state.policy?.mode ?? null); setDays(state.policy?.rollingDays?.toString() ?? ''); }
      setMessage(pending ? '上次保存结果尚待核对；请先按原请求核对，暂不接受新的政策选择。' : '');
    }).catch((e: unknown) => { if (active) setMessage(errorText(e)); });
    return () => { active = false; };
    // Pending is restored once for this family's component; later writes have their own readback.
  }, [ports, familyId]);
  const invalidate = () => { setReview(null); setConfirmed(false); setMessage('选择已改变，请重新预览影响并明确确认。'); };
  const valid = mode === 'UNTIL_GUARDIAN_DELETES' || mode === 'ROLLING_DAYS' && /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 3650;
  const save = async () => {
    if (!pending && (!review || !confirmed)) return;
    setBusy(true);
    try {
      const intent = pending?.intent ?? { mode: review!.mode, rollingDays: review!.rollingDays, previewVersion: review!.previewVersion };
      const state = await saveReviewedRetention(ports.client, intent, pending, remember);
      setSaved(state); setReview(null); setConfirmed(false);
      setMessage('保留政策已保存，并已从服务端读回确认。本次保存没有执行学习记录清理。');
    } catch (error) { setMessage(errorText(error)); setReview(null); setConfirmed(false); }
    finally { setBusy(false); }
  };
  return <fieldset>
    <legend>保留政策</legend>
    <p role="status">{saved ? saved.policy ? `已存政策：${saved.policy.mode === 'ROLLING_DAYS' ? `滚动保留 ${saved.policy.rollingDays} 天` : '保留到监护人删除'}。保存于 ${date(saved.policy.setAt)}。` : '尚未设置保留政策；当前没有启用按天数自动清理。' : '尚未读到已存政策，请核对连接和监护身份。'}</p>
    <p className="hint">滚动清理只在本地 Host 下次启动时检查并执行，当前页面不会定时清理；正在学习和暂停的记录不会自动删除。满保留天数的当天仍保留，超过该天数才进入范围。</p>
    <p className="hint">监护人另存的导出、外部备份不受此政策控制，不会自动清除。</p>
    <p>{saved?.lastCleanup ? `最近有实际删除记录的启动清理，检查时间 ${date(saved.lastCleanup.checkedAt)}，删除 ${saved.lastCleanup.deletedAttemptCount} 个学习尝试。` : '尚无实际删除的清理记录；这不表示已经完成一次清理。'}</p>
    <label><input type="radio" name="retention" checked={mode === 'UNTIL_GUARDIAN_DELETES'} disabled={busy || !!pending || !saved} onChange={() => { setMode('UNTIL_GUARDIAN_DELETES'); invalidate(); }} />保留到监护人删除</label>
    <label><input type="radio" name="retention" checked={mode === 'ROLLING_DAYS'} disabled={busy || !!pending || !saved} onChange={() => { setMode('ROLLING_DAYS'); invalidate(); }} />滚动保留</label>
    {mode === 'ROLLING_DAYS' ? <label>保留天数（1–3650）<input type="number" min={1} max={3650} value={days} disabled={busy || !!pending || !saved} onChange={(e) => { setDays(e.target.value); invalidate(); }} /></label> : null}
    <div className="btnrow">
      <button disabled={busy || !!pending || !valid || !saved} onClick={async () => {
        setBusy(true); setReview(null); setConfirmed(false);
        try {
          const projection = await ports.client.query({ kind: 'guardian.retentionPreview', mode: mode!, ...(mode === 'ROLLING_DAYS' ? { rollingDays: Number(days) } : {}) });
          if (projection.kind !== 'guardian.retentionPreview') throw new Error('保留政策预览不可用。');
          setReview(projection); setMessage('请审阅下方这一次预览。保存时服务端会再次核对范围，变化后需重新审阅。');
        } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); }
      }}>预览影响</button>
      <button disabled={busy} onClick={async () => { setBusy(true); setReview(null); setConfirmed(false); try { await readPolicy(); setMessage('已读取当前实际政策。'); } catch (e) { setMessage(errorText(e)); } finally { setBusy(false); } }}>读取当前政策</button>
    </div>
    {review ? <div role="group" aria-label="审阅保留政策影响">
      <p>本次预览：{review.mode === 'ROLLING_DAYS' ? `滚动保留 ${review.rollingDays} 天` : '保留到监护人删除'}；核对时间 {date(review.checkedAt)}。当前符合范围的学习尝试共 {review.affectedCount} 个。</p>
      {review.cutoffAt !== null ? <p>按最近学习活动判断，早于 {date(review.cutoffAt)} 的终态记录符合本次范围。未来启动时仍会按当时事实与已存政策检查。</p> : null}
      {review.affectedAttempts.length ? <table><thead><tr><th>学习者</th><th>状态</th><th>开始时间</th><th>最近活动</th></tr></thead><tbody>{review.affectedAttempts.map((a) => <tr key={a.attemptId}><td>{a.learnerAlias}</td><td>{statusLabel[a.status]}</td><td>{date(a.startedAt)}</td><td>{date(a.lastActivityAt)}</td></tr>)}</tbody></table> : <p>当前没有符合范围的学习尝试。</p>}
      {review.warnings.map((w) => <p key={w}>{w}</p>)}
      <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />我已审阅以上范围和清理时机，确认保存这项政策。</label>
      <div className="btnrow"><button disabled={busy} onClick={() => { setReview(null); setConfirmed(false); setMessage('已取消本次政策修改，未发送保存请求。'); }}>取消</button><button disabled={busy || !confirmed} onClick={() => void save()}>确认并保存政策</button></div>
    </div> : null}
    {pending ? <button disabled={busy || !saved} onClick={() => void save()}>按原请求核对保存结果</button> : null}
    {message ? <p role="status">{message}</p> : null}
  </fieldset>;
}
function errorText(error: unknown): string {
  const e = error as { code?: string; message?: string; transport?: string };
  if (e.code === 'UNAUTHENTICATED' || e.code === 'FORBIDDEN') return '监护身份不可用，请返回入口重新解锁后再试；没有确认政策已保存。';
  return e.message ?? '保留政策操作未完成，请重新核对。';
}
