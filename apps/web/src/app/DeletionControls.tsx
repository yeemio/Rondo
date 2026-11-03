import { useRef, useState } from 'react';
import { parseEnvelope } from '../../../../modules/contracts/public/envelope';
import type { PublicProjection, DeletionScope } from '../../../../modules/contracts/public/queries';
import type { CommandReceipt } from '../../../../modules/contracts/public/receipts';
import type { AppPorts } from '../client/ports';
import { clearDeletionCopies, deletionJournalKey, deliverDeletion, readDeletionJournal, type DeletionJournal } from '../client/deletion-state';
import { LESSONS } from '../content/bundled';

type Status = Extract<PublicProjection, { kind: 'guardian.deletionStatus' }>;
const targetLabels = { ALL_FAMILY_DATA: '本家庭全部学习数据', LEARNER: '一位学习者及其全部学习记录', ATTEMPT: '一次学习尝试' };
const countLabels: Record<string, string> = { learner: '学习者', learningAttempt: '学习尝试', learningCycle: '学习任务',
  questionInstance: '题目实例', prediction: '首次预测', hintPresentation: '提示记录', learningEvent: '过程事件',
  submission: '提交', evaluation: '判定', explanationRevision: '解释版本', guardianObservation: '监护观察',
  assistanceRecord: '帮助记录', transferPlan: '回看安排', retentionPolicy: '保留政策', hostSession: '会话', commandReceipt: '旧请求回执' };
const text = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);

export function DeletionControls({ ports, familyId, learners, busy, setBusy, onDeleted, onReenter, onClearExports }: {
  ports: AppPorts; familyId: string; learners: Array<{ learnerId: string; alias: string }>;
  busy: boolean; setBusy: (value: boolean) => void; onDeleted: (message: string) => void;
  onReenter: () => void; onClearExports: () => void;
}) {
  const [restored] = useState(() => { try { return { journal: readDeletionJournal(sessionStorage, familyId), error: '' }; }
    catch (error) { return { journal: null, error: `删除恢复记录无法读取：${text(error)} 请保留本标签页记录。` }; } });
  const [journal, setJournal] = useState<DeletionJournal | null>(restored.journal);
  const [target, setTarget] = useState<DeletionScope['target'] | ''>('');
  const [learnerId, setLearnerId] = useState('');
  const [attemptId, setAttemptId] = useState('');
  const [attempts, setAttempts] = useState<Array<{ attemptId: string; releaseId: string; startedAtMs: number }>>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState(restored.error || (restored.journal ? '保留了上次删除的原请求标识，请先核对结果；不会换键删除。' : ''));
  const [retryUnknown, setRetryUnknown] = useState(false);
  const inflight = useRef(false);
  const remember = (value: DeletionJournal | null) => {
    if (value) sessionStorage.setItem(deletionJournalKey(familyId), JSON.stringify(value));
    else sessionStorage.removeItem(deletionJournalKey(familyId));
    setJournal(value);
  };
  const run = async (action: () => Promise<void>) => {
    if (inflight.current) return;
    inflight.current = true; setBusy(true);
    try { await action(); } catch (error) {
      const code = (error as { code?: string }).code;
      setMessage(code === 'UNAUTHENTICATED' || code === 'FORBIDDEN'
        ? '监护会话已失效。请返回入口重新解锁，再按保留的原请求核对；当前未确认删除结果。'
        : `删除尚未完成核对：${text(error)} 原请求仍保留。`);
    } finally { inflight.current = false; setBusy(false); }
  };
  const readStatus = async (value: DeletionJournal) => {
    if (!value.deletionId) throw Error('缺少原准备操作标识。');
    const projection = await ports.client.query({ kind: 'guardian.deletionStatus', deletionId: value.deletionId,
      ...(value.envelope.kind === 'guardian.confirmDeletion' ? { confirmationKey: value.envelope.idempotencyKey } : {}) });
    if (projection.kind !== 'guardian.deletionStatus' || projection.deletionId !== value.deletionId) throw Error('删除状态未匹配原操作。');
    setStatus(projection);
    setMessage(projection.phase === 'PREPARED' ? '请核对下方具名范围。只有明确确认后才会删除。'
      : projection.phase === 'STALE' || projection.phase === 'EXPIRED' ? '该预览已失效，未按此预览扩大删除。请取消后重新选择并预览。'
      : '已从服务端读回原确认键对应的删除结果。');
  };
  const acceptReceipt = async (value: DeletionJournal, receipt: CommandReceipt) => {
    if (receipt.idempotencyKey !== value.envelope.idempotencyKey || receipt.kind !== value.envelope.kind)
      throw Error('回执与原删除请求不匹配，尚未确认结果。');
    if (receipt.status !== 'APPLIED') {
      remember(null); setStatus(null); setRetryUnknown(false);
      setMessage(`删除请求未应用（${receipt.errorCode ?? receipt.status}）。未据此清理浏览器副本，请重新选择并预览。`); return;
    }
    if (value.envelope.kind === 'guardian.prepareDeletion') {
      const id = receipt.effectRefs.find((ref) => ref.startsWith('disposal:'))?.slice(9);
      if (!id) throw Error('准备回执缺少删除操作标识。');
      const prepared = { ...value, deletionId: id }; remember(prepared); await readStatus(prepared); return;
    }
    if (!receipt.effectRefs.includes(`disposal:${value.deletionId}`)) throw Error('确认回执指向另一删除操作。');
    if (!value.copies) throw Error('缺少原已审阅副本范围；数据库回执已应用，浏览器清理尚未证实。');
    const cleanup = clearDeletionCopies(value.copies, localStorage, sessionStorage);
    const completed = { ...value, cleanup: value.cleanup ? { removedDrafts: value.cleanup.removedDrafts + cleanup.removedDrafts,
      removedExportRefs: value.cleanup.removedExportRefs + cleanup.removedExportRefs,
      revokedUrls: value.cleanup.revokedUrls + cleanup.revokedUrls, failed: cleanup.failed } : cleanup };
    onClearExports(); setRetryUnknown(false);
    try { remember(completed); } catch { setJournal(completed); }
    const session = await ports.auth.session();
    if (!session || session.role !== 'GUARDIAN' || session.familyId !== familyId) {
      onDeleted('数据库已提交删除，原会话已失效。请重新解锁后核对删除数量、剩余项和副本清理结果。'); return;
    }
    await readStatus(completed);
  };
  const prepare = () => run(async () => {
    if (!target) return;
    const targetId = target === 'LEARNER' ? learnerId : target === 'ATTEMPT' ? attemptId : undefined;
    const value: DeletionJournal = { familyId, envelope: parseEnvelope({ protocolVersion: 'rondo.v1',
      commandId: `cmd-${crypto.randomUUID()}`, idempotencyKey: `idem-${crypto.randomUUID()}`,
      kind: 'guardian.prepareDeletion', target: { scope: 'FAMILY' }, payload: { target, ...(targetId ? { targetId } : {}) } }) };
    remember(value); await acceptReceipt(value, await deliverDeletion(ports.client, value, false));
  });
  const confirm = () => run(async () => {
    if (!status?.scope || status.phase !== 'PREPARED' || !journal?.deletionId) return;
    const value: DeletionJournal = { familyId, deletionId: journal.deletionId,
      copies: { familyId, target: status.scope.target, learnerIds: status.scope.learners.map((l) => l.learnerId),
        attemptIds: status.scope.attempts.map((a) => a.attemptId) },
      envelope: parseEnvelope({ protocolVersion: 'rondo.v1', commandId: `cmd-${crypto.randomUUID()}`,
        idempotencyKey: `idem-${crypto.randomUUID()}`, kind: 'guardian.confirmDeletion', target: { scope: 'FAMILY' },
        payload: { preparedDeletionId: journal.deletionId, scopeListHash: status.scopeHash } }) };
    remember(value); setRetryUnknown(false); await acceptReceipt(value, await deliverDeletion(ports.client, value, false));
  });
  return <fieldset>
    <legend>删除学习数据（不可恢复）</legend>
    <p className="hint">仅删除本次具名范围。家庭和监护凭据保留，所有原家庭会话失效。浏览器清理范围为本浏览器已知草稿、本标签页临时导出文本与链接；已下载文件、其他标签页内存、工程备份和历史执行环境不在浏览器清理核验范围。</p>
    {!journal && !restored.error ? <>
      <label>删除范围<select value={target} disabled={busy} onChange={(event) => { setTarget(event.target.value as typeof target); setStatus(null); setLearnerId(''); setAttemptId(''); setAttempts([]); }}>
        <option value="">请选择要删除的范围</option>
        {Object.entries(targetLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      {target === 'LEARNER' || target === 'ATTEMPT' ? <label>学习者<select value={learnerId} disabled={busy} onChange={(event) => {
        const id = event.target.value; setLearnerId(id); setAttemptId(''); setAttempts([]);
        if (id && target === 'ATTEMPT') void run(async () => { if (!ports.view) throw Error('学习尝试列表不可用。'); setAttempts(await ports.view.listAttempts(id)); });
      }}><option value="">请选择学习者</option>{learners.map((l) => <option value={l.learnerId} key={l.learnerId}>{l.alias}</option>)}</select></label> : null}
      {target === 'ATTEMPT' ? <label>学习尝试<select value={attemptId} disabled={busy} onChange={(event) => setAttemptId(event.target.value)}>
        <option value="">请选择学习尝试</option>{attempts.map((a) => <option key={a.attemptId} value={a.attemptId}>{LESSONS.find((l) => l.releaseId === a.releaseId)?.title ?? a.releaseId} · {new Date(a.startedAtMs).toLocaleString()} · {a.attemptId}</option>)}
      </select></label> : null}
      <button disabled={busy || !target || (target === 'LEARNER' && !learnerId) || (target === 'ATTEMPT' && !attemptId)} onClick={() => void prepare()}>预览删除范围</button>
    </> : null}
    {journal ? <div className="btnrow">
      <button disabled={busy} onClick={() => void run(async () => {
        if (journal.envelope.kind === 'guardian.prepareDeletion' && journal.deletionId) { await readStatus(journal); return; }
        const lookup = await ports.client.receipt({ idempotencyKey: journal.envelope.idempotencyKey, commandKind: journal.envelope.kind });
        if (lookup.status === 'NOT_FOUND') { setRetryUnknown(true); setMessage('原键暂未查到回执，这不代表未执行。可以继续核对，或用原请求重试；不会换键。'); return; }
        await acceptReceipt(journal, lookup.receipt);
      })}>核对上次请求与结果</button>
      {retryUnknown ? <button disabled={busy} onClick={() => void run(async () => acceptReceipt(journal, await deliverDeletion(ports.client, journal, true)))}>按原请求重试</button> : null}
      {journal.envelope.kind === 'guardian.prepareDeletion' && journal.deletionId ? <button disabled={busy} onClick={() => {
        remember(null); setStatus(null); setRetryUnknown(false); setMessage('已取消本次预览，未发送删除确认；已有临时导出保留。');
      }}>取消删除</button> : null}
      {status?.result ? <button disabled={busy} onClick={() => { remember(null); setStatus(null); setMessage('可选择新的删除范围。'); }}>关闭已核对结果</button> : null}
    </div> : null}
    {status?.phase === 'PREPARED' && status.scope ? <div role="group" aria-label="核对并确认具名删除范围">
      <p><strong>{targetLabels[status.scope.target]}</strong> · {status.scope.learners.length} 位学习者 · {status.scope.attempts.length} 次尝试</p>
      <p>学习者：{status.scope.learners.length ? status.scope.learners.map((l) => l.alias).join('、') : '当前范围没有学习者记录'}</p>
      {status.scope.attempts.length ? <ul>{status.scope.attempts.map((a) => <li key={a.attemptId}>{status.scope!.learners.find((l) => l.learnerId === a.learnerId)?.alias} · {LESSONS.find((l) => l.releaseId === a.releaseId)?.title ?? a.releaseId} · {new Date(a.startedAtMs).toLocaleString()}（{a.endedAtMs ? `结束于 ${new Date(a.endedAtMs).toLocaleString()}` : '尚未结束'}） · {a.attemptId}</li>)}</ul> : <p>没有学习尝试；仍会按上方范围清理对应的学习者或政策记录。</p>}
      <p>{Object.entries(status.scope.counts).map(([table, count]) => `${countLabels[table] ?? table} ${count}`).join('；')}</p>
      <p className="hint">准备于 {new Date(status.preparedAtMs).toLocaleString()}，{new Date(status.expiresAtMs).toLocaleString()} 失效。期间记录变化或作业未结束时会拒绝确认，不会自动扩大范围。</p>
      <button className="danger" disabled={busy || journal?.envelope.kind === 'guardian.confirmDeletion'} onClick={() => void confirm()}>确认删除以上范围</button>
    </div> : null}
    {status?.result ? <div role="status">
      <p>数据库删除已提交。以下数量为事务完成时读回：{Object.entries(status.result.deleted).map(([table, count]) => `${countLabels[table] ?? table} ${count}`).join('；')}。</p>
      <p>范围内剩余：{Object.values(status.result.remaining).reduce((a, b) => a + b, 0)} 条。原会话已失效；当前为重新解锁后的会话。</p>
      <p>Host 代码副本：{status.result.hostCopies === 'CLEARED' ? '已清理可核对的终态内存副本' : status.result.hostCopies === 'NOT_PRESENT' ? '所选范围没有代码运行副本' : `尚有 ${status.result.failedJobCount || '待核对'} 项未完成，不代表数据库回滚`}。</p>
      <p>本浏览器已知草稿清理 {journal?.cleanup?.removedDrafts ?? 0} 项，本标签页临时导出链接撤销 {journal?.cleanup?.revokedUrls ?? 0} 项；{journal?.cleanup?.failed.length ? `仍有 ${journal.cleanup.failed.length} 处未能清理，可按原请求再次核对。` : journal?.cleanup ? '此受控范围清理已执行。' : '尚未证实清理。'}</p>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
    {journal?.envelope.kind === 'guardian.confirmDeletion' ? <button disabled={busy} onClick={onReenter}>返回入口重新解锁</button> : null}
    {journal?.deletionId ? <details><summary>删除操作详情</summary><p>准备操作：{journal.deletionId}</p><p>原请求键：{journal.envelope.idempotencyKey}</p></details> : null}
  </fieldset>;
}
