/**
 * Guardian surface: timeline review (question / first prediction / confirmed
 * changes / submissions / explanations / hint load), assistance recording
 * (four categories), rubric annotation, retention policy, export and
 * deletion with scope preview + confirmation. Never reachable without an
 * unlocked guardian session (App routes here only with a GUARDIAN session).
 */
import { useCallback, useEffect, useState } from 'react';
import type { AuthSession } from '../../../../modules/contracts/public/auth';
import { parseEnvelope } from '../../../../modules/contracts/public/envelope';
import type { AppPorts, TimelineDetailView } from '../client/ports';
import { getUiTask, LESSONS } from '../content/bundled';
import { mmToCmDisplay } from '../../../../modules/scenes/cylinder/geometry';
import { newId } from './prediction';
import { RetentionControls } from './RetentionControls';
import type { BrowserExportFile } from '../../../../modules/contracts/public/desktop';
import { prepareExportReference } from '../client/export-state';
import { downloadExportFile, EXPORT_LABELS } from '../client/browser-export';
import { DeletionControls } from './DeletionControls';

const ASSISTANCE_CATEGORIES = [
  { id: 'OPERATIVE', label: '操作帮助' },
  { id: 'RESTATE', label: '重述题意' },
  { id: 'CONCEPT', label: '概念提示' },
  { id: 'ANSWER', label: '给出答案' },
] as const;

const RUBRIC_ITEMS = [
  { key: 'condition', label: '条件（孩子说清了已知条件吗）' },
  { key: 'relation', label: '关系（说清了量之间的关系吗）' },
  { key: 'basis', label: '依据（说清了为什么这样判断吗）' },
] as const;

const RUBRIC_OPTIONS = [
  { id: 'NOT_OBSERVED', label: '未观察到' },
  { id: 'EMERGING', label: '初步出现' },
  { id: 'ESTABLISHED', label: '已能说明' },
] as const;

export function GuardianHome({
  ports,
  session,
  onExitToEntry,
  onEnterLearner,
  onDeleted,
}: {
  ports: AppPorts;
  session: AuthSession;
  onExitToEntry: () => void;
  onEnterLearner: (learnerId: string) => void;
  onDeleted: (message: string) => void;
}) {
  const [learners, setLearners] = useState<Array<{ learnerId: string; alias: string }>>([]);
  const [selectedLearner, setSelectedLearner] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Array<{ attemptId: string; releaseId: string; status: string; startedAtMs: number; finishedAtMs?: number }>>([]);
  const [timeline, setTimeline] = useState<TimelineDetailView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLearners(ports.view ? await ports.view.listLearners() : []);
    })();
  }, [ports]);

  const loadAttempts = useCallback(
    async (learnerId: string) => {
      const list = ports.view ? await ports.view.listAttempts(learnerId) : [];
      setAttempts(list);
      setTimeline(null);
    },
    [ports],
  );

  const openTimeline = async (attemptId: string) => {
    try {
      const frozen = await ports.client.query({ kind: 'learning.timeline', attemptId });
      void frozen;
      if (ports.view) setTimeline(await ports.view.getTimelineDetail(attemptId));
      else setNotice('时间线详情通道在真实桌面接入后显示（已用提示/预测原文等）。');
    } catch (err) {
      setNotice(errText(err));
    }
  };

  return (
    <section className="guardian">
      <div className="card">
        <h2>监护回看 · {session.displayName}的家庭</h2>
        <p className="hint">未经解锁不能进入本页；跨家庭对象对外统一不可见。</p>
        {!ports.view ? (
          <p className="hint">本页的详情数据（预测原文、判定、提示负担）由服务端通道提供，真实桌面接入后显示。</p>
        ) : null}
        <div className="learner-row">
          {learners.length ? (
            learners.map((l) => (
              <span key={l.learnerId}>
                <button className={selectedLearner === l.learnerId ? 'primary' : ''} onClick={() => { setSelectedLearner(l.learnerId); void loadAttempts(l.learnerId); }}>
                  回看 {l.alias}
                </button>{' '}
                <button onClick={() => onEnterLearner(l.learnerId)}>切换到 {l.alias} 学习</button>
              </span>
            ))
          ) : (
            <span className="hint">还没有学习者（首次设置时创建）。</span>
          )}
        </div>
      </div>

      {selectedLearner ? (
        <div className="card">
          <h3>学习时间线</h3>
          {attempts.length ? (
            <ul className="attempt-list">
              {attempts.map((a) => (
                <li key={a.attemptId}>
                  <button onClick={() => void openTimeline(a.attemptId)}>
                    {LESSONS.find((l) => l.releaseId === a.releaseId)?.title ?? a.releaseId} ·{' '}
                    {new Date(a.startedAtMs).toLocaleDateString()} · 状态 {attemptStatusText(a.status)}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">还没有学习尝试。</p>
          )}
          {timeline ? <TimelineView detail={timeline} ports={ports} selectedLearner={selectedLearner} onNotice={setNotice} /> : null}
        </div>
      ) : null}

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      <DataGovernance ports={ports} familyId={session.familyId} learners={learners} onNotice={setNotice} onDeleted={onDeleted} onReenter={onExitToEntry} />
      <div className="card">
        <button onClick={onExitToEntry}>锁定并退出到进入页</button>
      </div>
    </section>
  );
}

function TimelineView({
  detail,
  ports,
  selectedLearner,
  onNotice,
}: {
  detail: TimelineDetailView;
  ports: AppPorts;
  selectedLearner: string;
  onNotice: (s: string) => void;
}) {
  const [assistanceForm, setAssistanceForm] = useState<{ category: string; note: string } | null>(null);
  const [rubricFor, setRubricFor] = useState<{ cycleId: string } | null>(null);

  return (
    <div className="timeline">
      <h4>事件时间线（按服务端顺序）</h4>
      <ol>
        {detail.events.map((e) => (
          <li key={e.eventId} className="tl-event">
            <span className="tl-kind">{eventTypeText(e.eventType)}</span>{' '}
            <span className="tl-time">{new Date(e.occurredAtMs).toLocaleTimeString()}</span>
            <TimelinePayload payload={e.payload} />
          </li>
        ))}
      </ol>
      <div className="btnrow">
        <button
          onClick={() =>
            setAssistanceForm({ category: 'OPERATIVE', note: '' })
          }
        >
          补录介入
        </button>
        <button
          onClick={() => {
            // annotate the most recent explanation revision of this attempt
            const explainEvent = [...detail.events].reverse().find((e) => e.eventType === 'EXPLANATION_SAVED');
            if (!explainEvent) {
              onNotice('还没有可标注的解释。');
              return;
            }
            const cycleId = (explainEvent.payload?.cycleId as string | undefined) ?? explainEvent.eventId;
            setRubricFor({ cycleId });
          }}
        >
          人工解释观察（量规三项）
        </button>
      </div>
      {assistanceForm ? (
        <AssistanceForm
          ports={ports}
          attemptId={detail.attemptId}
          learnerNote={selectedLearner}
          initial={assistanceForm}
          onDone={(msg) => {
            setAssistanceForm(null);
            onNotice(msg);
          }}
        />
      ) : null}
      {rubricFor ? (
        <RubricForm ports={ports} cycleId={rubricFor.cycleId} onDone={(msg) => { setRubricFor(null); onNotice(msg); }} />
      ) : null}
    </div>
  );
}

function TimelinePayload({ payload }: { payload?: Record<string, unknown> }) {
  if (!payload) return null;
  const parts: string[] = [];
  if (payload.claims) parts.push(`预测断言：${(payload.claims as Array<{ propertyId: string; direction: string }>).map((c) => `${c.propertyId}=${directionText(c.direction)}`).join('、')}`);
  if (payload.uncertain === true) parts.push('预测：不确定');
  if (payload.explanation) parts.push(`预测原文：${String(payload.explanation)}`);
  if (payload.dimension && payload.fromMm !== undefined) {
    parts.push(`脚本化改变：${payload.dimension === 'RADIUS' ? '半径' : '高度'} ${mmToCmDisplay(Number(payload.fromMm))} → ${mmToCmDisplay(Number(payload.toMm))} cm`);
  }
  if (payload.operation) {
    const op = payload.operation as { type: string; dimension?: string; valueMm?: number; valuePermille?: number; section?: string };
    parts.push(`确认操作：${op.type}${op.dimension ? `(${op.dimension})` : ''}${op.valueMm !== undefined ? `=${mmToCmDisplay(op.valueMm)} cm` : ''}${op.valuePermille !== undefined ? `=${(op.valuePermille / 10).toFixed(0)}%` : ''}${op.section ? `=${op.section}` : ''}`);
  }
  if (payload.verdict) parts.push(`判定：${payload.verdict === 'CORRECT' ? '全部正确' : '有再试项'}`);
  if (payload.level) parts.push(`提示层级 h${payload.level}`);
  if (payload.category) parts.push(`介入类别：${String(payload.category)}`);
  if (payload.freeTextLength !== undefined) parts.push(`解释已保存（${payload.freeTextLength} 字${payload.transcribedByGuardian ? '，含代录标识' : ''}）`);
  if (payload.taskId) {
    try {
      parts.push(`任务：${getUiTask(String(payload.taskId)).title}`);
    } catch {
      /* unknown task id — skip */
    }
  }
  if (parts.length === 0) return null;
  return (
    <div className="tl-payload">
      {parts.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

function AssistanceForm({
  ports,
  attemptId,
  initial,
  onDone,
}: {
  ports: AppPorts;
  attemptId: string;
  learnerNote: string;
  initial: { category: string; note: string };
  onDone: (msg: string) => void;
}) {
  const [category, setCategory] = useState(initial.category);
  const [note, setNote] = useState(initial.note);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!note.trim()) return;
        setBusy(true);
        try {
          await ports.client.command(parseEnvelope({
            protocolVersion: 'rondo.v1',
            commandId: newId('cmd'),
            idempotencyKey: newId('idem'),
            kind: 'guardian.recordAssistance',
            target: { scope: 'FAMILY' },
            payload: { attemptId, category, note },
          }));
          onDone('介入已补录（会修正独立完成的证据标签，不改孩子原始提交）。');
        } catch (err) {
          onNoticeErr(err, onDone);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        类别
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {ASSISTANCE_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="stack">
        时间与说明（必填）
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} required />
      </label>
      <button type="submit" disabled={busy}>
        保存补录
      </button>
    </form>
  );
}

function RubricForm({ ports, cycleId, onDone }: { ports: AppPorts; cycleId: string; onDone: (msg: string) => void }) {
  const [rubric, setRubric] = useState({ condition: 'NOT_OBSERVED', relation: 'NOT_OBSERVED', basis: 'NOT_OBSERVED' });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const revisionRef = ports.view ? await ports.view.registerExplanationRevision(cycleId) : null;
          if (!revisionRef) {
            onDone('解释修订登记通道未连接。');
            return;
          }
          await ports.client.command(parseEnvelope({
            protocolVersion: 'rondo.v1',
            commandId: newId('cmd'),
            idempotencyKey: newId('idem'),
            kind: 'guardian.annotateExplanation',
            target: { scope: 'FAMILY' },
            payload: { explanationRevisionRef: revisionRef, rubric, note: note || undefined },
          }));
          onDone('人工观察已记录（量规三项，标注观察者与修订）。');
        } catch (err) {
          onNoticeErr(err, onDone);
        } finally {
          setBusy(false);
        }
      }}
    >
      {RUBRIC_ITEMS.map((item) => (
        <label key={item.key}>
          {item.key}
          <select value={rubric[item.key]} onChange={(e) => setRubric((r) => ({ ...r, [item.key]: e.target.value }))}>
            {RUBRIC_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {item.label} — {o.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label className="stack">
        备注（可选）
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button type="submit" disabled={busy}>
        保存观察
      </button>
    </form>
  );
}

function DataGovernance({ ports, familyId, learners, onNotice, onDeleted, onReenter }: {
  ports: AppPorts;
  familyId: string;
  learners: Array<{ learnerId: string; alias: string }>;
  onNotice: (s: string) => void;
  onDeleted: (message: string) => void;
  onReenter: () => void;
}) {
  const [exportEpoch, setExportEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card">
      <h3>数据治理</h3>
      <RetentionControls ports={ports} familyId={familyId} busy={busy} setBusy={setBusy} />
      <ExportControls key={exportEpoch} ports={ports} familyId={familyId} busy={busy} setBusy={setBusy} onNotice={onNotice} />
      <DeletionControls ports={ports} familyId={familyId} learners={learners} busy={busy} setBusy={setBusy}
        onDeleted={onDeleted} onReenter={onReenter} onClearExports={() => setExportEpoch((value) => value + 1)} />
    </div>
  );
}

function eventTypeText(t: string): string {
  // Two vocabularies hit this map: the mock client's (CYCLE_OPENED …) and
  // the server projection's (modules/learning events: CYCLE_BEGUN,
  // SUBMISSION_RECORDED …). Unknown keys fall back to the raw text —
  // display-layer mapping only, the transport contract is untouched.
  const map: Record<string, string> = {
    ATTEMPT_STARTED: '开始学习尝试',
    ATTEMPT_PAUSED: '已暂停',
    ATTEMPT_RESUMED: '已恢复',
    ATTEMPT_FINISHED: '完成本次学习',
    ATTEMPT_ABANDONED: '未完成结束',
    // server vocabulary
    CYCLE_BEGUN: '开始任务',
    PREDICTION_RECORDED: '首次预测',
    OPERATION_COMMITTED: '确认操作',
    SUBMISSION_RECORDED: '提交与判定',
    RESPONSE_REVISE_OPENED: '回到修改',
    HINT_PRESENTED: '提示',
    EXPLANATION_BEGUN: '开始解释',
    EXPLANATION_SAVED: '解释保存',
    ASSISTANCE_RECORDED: '介入补录',
    // mock vocabulary
    CYCLE_OPENED: '开始任务',
    SCRIPT_CHANGE_APPLIED: '内容脚本变更',
    OPERATION_CONFIRMED: '确认操作',
    SUBMISSION_EVALUATED: '提交与判定',
    REVISE_ENTERED: '回到修改',
    HINT_SHOWN: '提示',
    EXPLAIN_ENTERED: '开始解释',
    OBSERVATION_RECORDED: '人工观察',
    MIGRATION_PLANNED: '回看练习安排',
    MIGRATION_STARTED: '回看练习开始',
  };
  return map[t] ?? t;
}
function attemptStatusText(s: string): string {
  const map: Record<string, string> = {
    ACTIVE: '进行中',
    PAUSED: '已暂停',
    COMPLETED: '已完成',
    ABANDONED: '已结束（未完成）',
    CONTENT_BLOCKED: '内容不可用',
  };
  return map[s] ?? s;
}
function directionText(d: string): string {
  const map: Record<string, string> = { INCREASE: '变大', DECREASE: '变小', UNCHANGED: '不变' };
  return map[d] ?? d;
}
function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: string }).message);
  return String(err);
}
function onNoticeErr(err: unknown, onDone: (s: string) => void): void {
  onDone(errText(err));
}

/** Retain only the opaque operation reference across re-entry; never retain learning payloads. */
function ExportControls({ ports, familyId, busy, setBusy, onNotice }: {
  ports: AppPorts; familyId: string; busy: boolean; setBusy: (value: boolean) => void; onNotice: (s: string) => void;
}) {
  const storageKey = `rondo.export.${familyId}`;
  const [restored] = useState<{ ref: string | null; prepareKey?: string; categories: string[] } | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      return value && (typeof value.ref === 'string' || typeof value.prepareKey === 'string') && Array.isArray(value.categories) && value.categories.length > 0 &&
        value.categories.every((c: unknown) => typeof c === 'string' && Object.hasOwn(EXPORT_LABELS, c)) ? value : null;
    } catch { return null; }
  });
  const [categories, setCategories] = useState<string[]>(restored?.categories ?? Object.keys(EXPORT_LABELS));
  const [ref, setRef] = useState<string | null>(restored?.ref ?? null);
  const [prepareKey, setPrepareKey] = useState<string | null>(restored?.prepareKey ?? null);
  const [reviewing, setReviewing] = useState(false);
  const [files, setFiles] = useState<BrowserExportFile[] | null>(null);
  const [fileStatuses, setFileStatuses] = useState<Record<string, string>>({});
  const [scopeHash, setScopeHash] = useState<string | undefined>();
  const [message, setMessage] = useState(ref ? '保留了上次导出标识；上次下载或保存结果未证实，可核对范围后继续。' : '');
  const remember = (value: string | null, pending: string | null = null) => {
    setRef(value); setPrepareKey(pending);
    try { if (value || pending) sessionStorage.setItem(storageKey, JSON.stringify({ ref: value, prepareKey: pending, categories })); else sessionStorage.removeItem(storageKey); } catch { /* In-memory retry remains available. */ }
  };
  const review = async () => {
    setBusy(true);
    try {
      let current = ref;
      if (!current) current = await prepareExportReference(ports.client, categories, prepareKey, remember);
      // A resumed reference is resolved by the Host, never inferred from local state.
      const status = await ports.client.query({ kind: 'guardian.exportStatus', exportId: current });
      if (status.kind !== 'guardian.exportStatus') throw new Error('导出状态不可用。');
      setScopeHash(status.scopeHash);
      setMessage('请核对本家庭的已选类别。确认后会准备两份文件，再分别点击下载。');
      setReviewing(true);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setMessage(code === 'UNAUTHENTICATED' || code === 'FORBIDDEN' ? '监护身份不可用，请返回入口重新解锁后，再继续导出。' : errText(err));
    } finally { setBusy(false); }
  };
  return <fieldset>
    <legend>导出本家庭学习记录</legend>
    <p className="hint">范围：当前解锁监护人的本家庭。提供 UTF-8 JSON 与可读文本摘要；导出时读取当前学习事实。不会删除学习记录。</p>
    {Object.entries(EXPORT_LABELS).map(([key, label]) => <label key={key}>
      <input type="checkbox" checked={categories.includes(key)} disabled={busy || !!ref || !!prepareKey}
        onChange={(e) => setCategories(e.target.checked ? [...categories, key] : categories.filter((c) => c !== key))} />{label}
    </label>)}
    <p className="hint">不含凭据、会话、私有规则/答案/测试、其他家庭数据及工程控制文件。浏览器下载发起不代表已经保存到磁盘。</p>
    <div className="btnrow">
      <button disabled={busy || !categories.length || !!files} onClick={() => void review()}>{ref || prepareKey ? '核对并继续上次导出' : '预览导出范围'}</button>
      {ref ? <button disabled={busy} onClick={() => { remember(null); setReviewing(false); setFiles(null); setFileStatuses({}); setScopeHash(undefined); setMessage('可重新选择范围并准备一项新导出。'); }}>重新选择范围</button> : null}
    </div>
    {reviewing && ref ? <div role="group" aria-label="确认导出范围">
      <p>确认以上范围后准备 JSON 与摘要；你可以随后分别下载。取消不会发起下载。</p>
      <button disabled={busy} onClick={() => { setReviewing(false); setMessage('已取消本次导出，未发起下载；保留原导出标识供继续。'); }}>取消</button>
      <button disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const status = await ports.client.query({ kind: 'guardian.exportStatus', exportId: ref });
          if (status.kind !== 'guardian.exportStatus') throw new Error('导出状态不可用。');
          if (status.phase === 'PREPARED') {
            await ports.client.command(parseEnvelope({ protocolVersion: 'rondo.v1', commandId: newId('cmd'), idempotencyKey: newId('idem'),
              kind: 'guardian.confirmExport', target: { scope: 'FAMILY' }, payload: { preparedVersion: ref } }));
          } else if (status.phase !== 'CONFIRMED' && status.phase !== 'COMPLETED') throw new Error('该导出不可继续，请重新选择范围。');
          const result = await ports.desktop.saveExport({ preparedExportRef: ref });
          if (result.files) {
            setFiles(result.files); setFileStatuses({});
            setMessage('两份文件已准备好，请分别点击下方的下载按钮。两份文件来自本次同一份学习记录。');
          } else {
            const text = result.saved ? `已证实保存：${result.savedToLabel ?? '本地文件'}。` : '已取消保存，未证实磁盘保存。';
            setMessage(text); onNotice(text);
          }
          setReviewing(false);
        } catch (err) { setMessage(`导出未完成：${errText(err)} 保存未证实；保留原标识，可继续重试。`); }
        finally { setBusy(false); }
      }}>确认范围并准备文件</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
    {files ? <div role="group" aria-label="分别下载导出文件">
      {files.map((file, index) => <div key={file.name}>
        <button disabled={busy} onClick={() => {
          const result = downloadExportFile(file, familyId);
          setFileStatuses((previous) => ({ ...previous, [file.name]: result.detail ?? '保存尚未证实。' }));
        }}>{index === 0 ? '下载 JSON 学习记录' : '下载可读文本摘要'}</button>
        {fileStatuses[file.name] ? <p role="status">{fileStatuses[file.name]}</p> : null}
      </div>)}
      <p className="hint">请分别检查两份文件的下载结果；页面无法证实它们已经保存到磁盘。</p>
    </div> : null}
    {ref ? <details><summary>导出技术详情</summary><p>标识：{ref}</p><p>范围校验：{scopeHash ?? '继续核对后显示'}</p></details> : null}
  </fieldset>;
}
