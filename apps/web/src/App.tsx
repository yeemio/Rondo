/**
 * Rondo web app shell: local entry (guardian setup / unlock / learner
 * switch / lock), lesson selection with resume point and the delayed-review
 * card, the task player, and the guardian review surface.
 *
 * One player for both lessons — no per-subject app variants (C-EXPERIENCE).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthSession } from '../../../modules/contracts/public/auth';
import { parseEnvelope } from '../../../modules/contracts/public/envelope';
import type { AppPorts } from './client/ports';
import type { MigrationCardView } from './client/ports';
import { LESSONS } from './content/bundled';
import { Player } from './app/Player';
import { MvpHome, MvpPlayer } from './app/Mvp';
import { GuardianHome } from './app/Guardian';

type Screen =
  | { name: 'boot' }
  | { name: 'entry' }
  | { name: 'learner-home'; learnerId: string; session: AuthSession }
  | { name: 'player'; learnerId: string; attemptId: string; releaseId: string; session: AuthSession | null }
  | { name: 'guardian'; session: AuthSession };

export function App({ ports }: { ports: AppPorts }) {
  const [screen, setScreen] = useState<Screen>({ name: 'boot' });
  const [session, setSession] = useState<AuthSession | null>(null);
  const [subject,setSubject]=useState(0);
  const [deletionNotice, setDeletionNotice] = useState('');
  const [learningLeaveError, setLearningLeaveError] = useState('');
  const playerLeave = useRef<(() => Promise<boolean>) | null>(null);
  const registerPlayerLeave = useCallback((guard: (() => Promise<boolean>) | null) => { playerLeave.current = guard; }, []);

  useEffect(() => {
    void (async () => {
      try {
        const s = await ports.auth.session();
        setSession(s);
        if (!s) setScreen({ name: 'entry' });
        else if (s.role === 'LEARNER' && s.learnerId) setScreen({ name: 'learner-home', learnerId: s.learnerId, session: s });
        else setScreen({ name: 'guardian', session: s });
      } catch {
        setScreen({ name: 'entry' });
      }
    })();
  }, [ports]);

  const refreshSession = useCallback(async () => {
    const s = await ports.auth.session();
    setSession(s);
    if (!s) setScreen({ name: 'entry' });
    return s;
  }, [ports]);

  const leaveLearning = async (action: () => void | Promise<void>) => {
    setLearningLeaveError('');
    if (screen.name === 'player' && screen.releaseId.startsWith('rondo.mvp.') && playerLeave.current && !await playerLeave.current()) return;
    try { await action(); } catch { setLearningLeaveError('暂时未能离开，当前页面与编辑仍保留，请稍后再试。'); }
  };

  if (screen.name === 'boot') {
    return (
      <div className="app-root">
        <section className="card entry-card">
          <p>正在打开你的学习书…</p>
        </section>
      </div>
    );
  }

  return (
    <div className="studio-app">
      <a className="skip" href="#learning-space">跳到学习空间</a>
      <header className="studio-header">
        <a className="brand" href="#" onClick={e=>{e.preventDefault();if(session?.role==='LEARNER'&&session.learnerId)void leaveLearning(()=>setScreen({name:'learner-home',learnerId:session.learnerId!,session}));}} aria-label="Rondo 回旋曲，学习首页"><span className="brand-mark" aria-hidden="true"/><span>Rondo<small>回旋曲</small></span></a>
        <p>把想法，变成发现。</p>
        <details className="studio-profile"><summary className="quiet-button">{session?.displayName??'我的学习书'} <span className="info-icon" aria-hidden="true">i</span></summary><div><p>记录保存在这台电脑上。</p>{session?<button className="text-button" onClick={()=>void leaveLearning(async()=>{await ports.auth.lock();await refreshSession();})}>暂时离开</button>:null}</div></details>
      </header>
      <main id="learning-space" className="studio-main" aria-live="polite">
        {learningLeaveError ? <p role="alert">{learningLeaveError}</p> : null}
        {screen.name === 'entry' && deletionNotice ? <p role="status">{deletionNotice}</p> : null}
        {screen.name === 'entry' ? (
          <EntryScreen
            ports={ports}
            onSession={async (s) => {
              setSession(s);
              if (s.role === 'LEARNER' && s.learnerId) setScreen({ name: 'learner-home', learnerId: s.learnerId, session: s });
              else setScreen({ name: 'guardian', session: s });
            }}
          />
        ) : null}
        {screen.name === 'learner-home' ? (
          <MvpHome
            ports={ports}
            learnerId={screen.learnerId}
            familyId={screen.session.familyId}
            subject={subject}
            onSubject={setSubject}
            onOpenAttempt={(attemptId, releaseId) => setScreen({ name: 'player', learnerId: screen.learnerId, attemptId, releaseId, session })}
            onLock={async () => {
              await ports.auth.lock();
              await refreshSession();
            }}
            onGuardian={async () => {
              await ports.auth.lock();
              await refreshSession();
            }}
          />
        ) : null}
        {screen.name === 'player' && screen.releaseId.startsWith('rondo.mvp.') ? <MvpPlayer key={screen.attemptId} ports={ports} learnerId={screen.learnerId} familyId={(screen.session??session)!.familyId} attemptId={screen.attemptId} releaseId={screen.releaseId} onRegisterLeave={registerPlayerLeave} onSubject={index=>{setSubject(index);setScreen({name:'learner-home',learnerId:screen.learnerId,session:(screen.session??session) as AuthSession});}} onExit={()=>setScreen({name:'learner-home',learnerId:screen.learnerId,session:(screen.session??session) as AuthSession})}/> : null}
        {screen.name === 'player' && !screen.releaseId.startsWith('rondo.mvp.') ? (
          <Player
            ports={ports}
            learnerId={screen.learnerId}
            attemptId={screen.attemptId}
            releaseId={screen.releaseId}
            onExit={() => setScreen({ name: 'learner-home', learnerId: screen.learnerId, session: (screen.session ?? session) as AuthSession })}
            onFinished={async () => {
              const s = await refreshSession();
              if (s && s.role === 'LEARNER' && s.learnerId) {
                setScreen({ name: 'learner-home', learnerId: s.learnerId, session: s });
              }
            }}
          />
        ) : null}
        {screen.name === 'guardian' ? (
          <GuardianHome
            ports={ports}
            session={screen.session}
            onDeleted={(message) => { setDeletionNotice(message); setSession(null); setScreen({ name: 'entry' }); }}
            onExitToEntry={async () => {
              await ports.auth.lock();
              await refreshSession();
            }}
            onEnterLearner={async (learnerId) => {
              const s = await ports.auth.enterLearner({ learnerId });
              setSession(s);
              setScreen({ name: 'learner-home', learnerId, session: s });
            }}
          />
        ) : null}
      </main>
    </div>
  );
}

function SessionBadge({ session }: { session: AuthSession | null }) {
  if (!session) return <span className="badge">未进入</span>;
  const roleText = session.role === 'GUARDIAN' ? '监护人' : '学习者';
  return (
    <span className="badge">
      {roleText}：{session.displayName}
    </span>
  );
}

let setupCompletedThisRun = false;

// ---------------------------------------------------------------------------
// Entry: first-run guardian setup / unlock / (guardian session) learner switch
// ---------------------------------------------------------------------------
function EntryScreen({
  ports,
  onSession,
}: {
  ports: AppPorts;
  onSession: (s: AuthSession) => void;
  hasFamily?: boolean;
}) {
  const [mode, setMode] = useState<'unknown' | 'setup' | 'unlock'>('unknown');
  const [familyName, setFamilyName] = useState('');
  const [guardianName, setGuardianName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [alias, setAlias] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [learners, setLearners] = useState<Array<{ learnerId: string; alias: string }>>([]);

  const tryUnlock = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await ports.auth.unlockGuardian({ passphrase });
      const list = ports.view ? await ports.view.listLearners() : [];
      setLearners(list);
      onSession(s);
    } catch (err) {
      setError(errText(err));
      setMode(passphrase ? 'unlock' : 'unlock');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void (async () => {
      if (setupCompletedThisRun) {
        setMode('unlock');
        return;
      }
      // Structured routing signal from the A-owned platform surface. Never
      // parse auth error text to decide setup vs unlock — the old probe also
      // burned real failed-attempt counters on initialized roots.
      try {
        const info = await ports.platform?.info();
        setMode(info?.guardianConfigured === true ? 'unlock' : 'setup');
      } catch {
        setMode('setup');
      }
    })();
  }, [ports]);

  return (
    <section className="card entry-card">
      <h2>{mode === 'setup' ? '首次使用 · 建立家庭' : '进入 Rondo'}</h2>
      {mode === 'setup' ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await ports.auth.setupGuardian({
                idempotencyKey: `setup-${familyName}-${guardianName}`.replace(/\s+/g, '-'),
                familyDisplayName: familyName,
                guardianDisplayName: guardianName,
                passphrase,
              });
              const s = await ports.auth.unlockGuardian({ passphrase });
              if (alias.trim()) {
                await ports.client.command(parseEnvelope({
                  protocolVersion: 'rondo.v1',
                  commandId: `cmd-newlearner-${Date.now()}`,
                  idempotencyKey: `first-learner-${familyName}-${alias}`.replace(/\s+/g, '-'),
                  kind: 'family.createLearner',
                  target: { scope: 'FAMILY' },
                  payload: { alias: alias.trim() },
                }));
              }
              setupCompletedThisRun = true;
              onSession(s);
            } catch (err) {
              setError(errText(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            家庭名称
            <input value={familyName} onChange={(e) => setFamilyName(e.target.value)} required minLength={1} />
          </label>
          <label>
            监护人称呼
            <input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} required minLength={1} />
          </label>
          <label>
            监护口令（至少8位，仅在这台电脑上验证）
            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} required minLength={8} />
          </label>
          <label>
            孩子的称呼（创建第一位学习者）
            <input value={alias} onChange={(e) => setAlias(e.target.value)} required minLength={1} />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? '创建中…' : '建立家庭并进入'}
          </button>
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await tryUnlock();
          }}
        >
          <label>
            监护口令
            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} required />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? '验证中…' : '解锁监护人'}
          </button>
          <p className="hint">解锁后可进入监护回看，或在监护会话内切换到孩子。</p>
        </form>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {learners.length > 0 ? <p>已解锁。请在监护首页切换学习者。</p> : null}
    </section>
  );
}

function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: string }).message);
  return String(err);
}

// ---------------------------------------------------------------------------
// Learner home: lesson cards + resume + delayed-review card
// ---------------------------------------------------------------------------
function LearnerHome({
  ports,
  learnerId,
  onOpenAttempt,
  onLock,
  onGuardian,
}: {
  ports: AppPorts;
  learnerId: string;
  session: AuthSession;
  onOpenAttempt: (attemptId: string, releaseId: string) => void;
  onLock: () => void;
  onGuardian: () => void;
}) {
  const [resume, setResume] = useState<{ attemptId: string; cycleId: string; phase: string; version: number } | null>(null);
  const [resumeRelease, setResumeRelease] = useState<string | null>(null);
  const [migration, setMigration] = useState<MigrationCardView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const proj = await ports.client.query({ kind: 'learning.resumePoint', learnerId });
      if (proj.kind === 'learning.resumePoint') {
        setResume(proj.attempt);
        if (proj.attempt) {
          const view = await ports.client.query({ kind: 'learning.attemptView', attemptId: proj.attempt.attemptId });
          if (view.kind === 'learning.attemptView') setResumeRelease(view.releaseId);
        }
      }
      if (ports.view) {
        setMigration((await ports.view.getMigration(learnerId)) ?? null);
      } else {
        setMigration(null);
      }
    } catch (err) {
      setError(errText(err));
    }
  }, [ports, learnerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const startLesson = async (releaseId: string) => {
    setBusy(true);
    setError(null);
    try {
      // idempotent: an existing ACTIVE/PAUSED attempt is returned as-is
      const key = `start-${learnerId}-${releaseId}`;
      const receipt = await ports.client.command(parseEnvelope({
        protocolVersion: 'rondo.v1',
        commandId: `cmd-${key}`,
        idempotencyKey: key,
        kind: 'learning.startAttempt',
        target: { scope: 'LEARNER', learnerId },
        payload: { releaseId },
      }));
      const attemptRef = receipt.effectRefs.find((r) => r.startsWith('attempt:'));
      if (attemptRef) onOpenAttempt(attemptRef.slice('attempt:'.length), releaseId);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const startDelayed = async () => {
    setBusy(true);
    setError(null);
    try {
      // open the lesson whose delayed task is actually scheduled (cylinder L2/L4
      // or one of the theme/cpp lessons) — never blindly the first match
      const lesson = migration
        ? LESSONS.find((l) => l.delayedTransferTaskId === migration.taskId)
        : LESSONS.find((l) => l.delayedTransferTaskId);
      if (!lesson) return;
      await startLesson(lesson.releaseId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="learner-home">
      <div className="card">
        <h2>继续学习</h2>
        {resume ? (
          <button
            className="primary"
            onClick={() => resumeRelease && onOpenAttempt(resume.attemptId, resumeRelease)}
          >
            继续上次（{LESSONS.find((l) => l.releaseId === resumeRelease)?.title ?? resumeRelease} · 阶段 {phaseText(resume.phase)}）
          </button>
        ) : (
          <p className="hint">还没有进行中的学习。</p>
        )}
        <h3>从这个问题开始</h3>
        <div className="lesson-row">
          {LESSONS.map((l) => (
            <button key={l.lessonId} disabled={busy} onClick={() => void startLesson(l.releaseId)}>
              {l.title}
            </button>
          ))}
        </div>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="card">
        <h3>回看练习（7–14 天后）</h3>
        {!ports.view ? (
          <p className="hint">回看练习安排由服务端管理；该通道在真实桌面接入后显示。</p>
        ) : migration ? (
          <DelayedCard migration={migration} busy={busy} onStart={startDelayed} />
        ) : (
          <p className="hint">回看练习由服务端在真实到达时间窗口后安排；当前版本还没有已安排的回看练习（后续批次接入）。</p>
        )}
      </div>
      <div className="card">
        <button onClick={onGuardian}>回到监护首页</button>{' '}
        <button onClick={onLock}>锁定本窗口</button>
        <p className="hint">锁定只退出当前会话，不会删除已保存的学习记录。</p>
      </div>
    </section>
  );
}

function DelayedCard({
  migration,
  busy,
  onStart,
}: {
  migration: MigrationCardView;
  busy: boolean;
  onStart: () => void;
}) {
  const stateText: Record<string, string> = {
    PLANNED: '已安排',
    AVAILABLE: '可以开始',
    STARTED: '已开始',
    OBSERVED: '已完成观察',
    DEFERRED: '已改期',
    CANCELLED: '已取消',
  };
  return (
    <div className="delayed-card">
      <p>
        {migration.taskTitle} · 状态：<strong>{stateText[migration.state] ?? migration.state}</strong>
      </p>
      {migration.state === 'PLANNED' || migration.state === 'DEFERRED' ? (
        <p className="hint">预计 {new Date(migration.availableAtMs).toLocaleDateString()} 可开始（还有约 {migration.remainingDays} 天）。</p>
      ) : null}
      {migration.state === 'AVAILABLE' ? (
        <button className="primary" disabled={busy} onClick={onStart}>
          开始回看练习
        </button>
      ) : null}
      {migration.state === 'OBSERVED' ? (
        <p className="hint">实际间隔 {migration.actualIntervalDays ?? '—'} 天，已完成观察记录。</p>
      ) : null}
      <p className="hint">回看练习只在真实到达时间窗口后才能开始；不会发提醒或通知。</p>
    </div>
  );
}

export function phaseText(phase: string): string {
  const map: Record<string, string> = {
    PREDICT: '预测',
    OPERATE: '操作',
    VERIFY: '核对',
    EXPLAIN: '解释',
    REVIEW: '回看',
  };
  return map[phase] ?? phase;
}
