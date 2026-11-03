/**
 * MOCK_ONLY deterministic local stub implementing the frozen RondoClient /
 * LocalAuthPort / DesktopPort interfaces for isolated development and tests.
 *
 * - Same contracts, same envelopes, same stable error codes; in-memory store.
 * - NOT wired into the product route: apps/web/src/main.tsx (product entry)
 *   never imports this module; only main.dev.tsx (dev bundle) and node tests
 *   do. The dev UI shows a permanent MOCK_ONLY badge.
 * - The extra MockViewPort surface below covers read needs the frozen
 *   projection catalog cannot express yet (evaluation feedback, hint content,
 *   review reveal, migration schedule, timeline payload). Each is a named
 *   CONTRACT_CHANGE_REQUIRED item in the C report; A/B resolve them and this
 *   port shrinks to zero.
 */
import type { RondoClient, Unsubscribe } from '../contracts/public/client';
import type { InvalidationNotice } from '../contracts/public/client';
import type { LocalAuthPort, AuthSession, SetupGuardianInput, UnlockGuardianInput, EnterLearnerInput, LockResult } from '../contracts/public/auth';
import type { DesktopPort, SaveExportInput, SaveExportResult, QuitFlowState, HostStatusProjection } from '../contracts/public/desktop';
import type { PublicCommandEnvelope } from '../contracts/public/envelope';
import type { CommandReceipt } from '../contracts/public/receipts';
import type { PublicProjection, PublicQuery } from '../contracts/public/queries';
import type { ReceiptLookup } from '../contracts/public/receipts';
import { MockDeliveryLostError, MockStore, type MockStoreOptions } from './store';

export interface MockHintView {
  level: number;
  text: string;
  marksAnswerAssistance: boolean;
  atMs: number;
}

export interface MockViewPort {
  /** MOCK gap: EVALUATION_FEEDBACK_CHANNEL */
  getEvaluation(cycleId: string): {
    submissionId: string;
    seq: number;
    atMs: number;
    verdict: 'CORRECT' | 'REVISE';
    itemResults: Array<{ key: string; label: string; verdict: string; feedback?: string }>;
    diagnostics: string[];
    answerAssistanceActive: boolean;
  } | null;
  /** MOCK gap: HINT_CONTENT_CHANNEL */
  getHints(cycleId: string): MockHintView[];
  /** MOCK gap: EVALUATION_FEEDBACK_CHANNEL (review reveal gated on REVIEW) */
  getReviewCard(cycleId: string): unknown;
  /** MOCK gap: MIGRATION_SCHEDULE_PROJECTION */
  getMigration(learnerId: string): unknown;
  deferMigration(learnerId: string, days: number): void;
  /** MOCK gap: TIMELINE_EVENT_PAYLOAD */
  getTimelineDetail(attemptId: string): unknown;
  listLearners(): Array<{ learnerId: string; alias: string }>;
  listAttempts(learnerId?: string): unknown[];
  registerExplanationRevision(cycleId: string): string;
  getLastDeletionScopeHash(): string | null;
  nowMs(): number;
}

export interface MockPorts extends RondoClient, LocalAuthPort, DesktopPort {
  readonly mock: MockViewPort;
  readonly platform: { info(): Promise<{ guardianConfigured: boolean }> };
  readonly isMock: true;
}

export function createMockRondo(options: MockStoreOptions = {}): MockPorts {
  const store = new MockStore(options);
  const subscribers: Array<(n: InvalidationNotice) => void> = [];

  const notify = (attemptId: string, version: number, changedKinds: string[]): void => {
    const notice: InvalidationNotice = { attemptId, version, changedKinds };
    for (const cb of subscribers) cb(notice);
  };

  const ports: MockPorts = {
    isMock: true as const,
    platform: { info: async () => ({ guardianConfigured: store.hasFamily }) },
    // ----- RondoClient -----
    async command(envelope: PublicCommandEnvelope): Promise<CommandReceipt> {
      try {
        const receipt = await store.handleCommand(envelope);
        if (receipt.attemptVersion !== undefined && receipt.status === 'APPLIED') {
          notify(
            (envelope.target as { attemptId?: string }).attemptId ?? 'unknown',
            receipt.attemptVersion,
            receipt.changedKinds,
          );
        }
        return receipt;
      } catch (err) {
        if (err instanceof MockDeliveryLostError) {
          // committed server-side; receipt never arrives — the UI must query
          // the ORIGINAL key, never resend under a new one
          throw err;
        }
        throw err;
      }
    },
    async query(request: PublicQuery): Promise<PublicProjection> {
      return store.handleQuery(request);
    },
    async receipt(request: { idempotencyKey: string; commandKind: string }): Promise<ReceiptLookup> {
      const session = store.currentSession;
      if (!session) {
        throw { code: 'UNAUTHENTICATED', message: '没有活动会话。' } as never;
      }
      return store.lookupReceipt(session.actorId, request.idempotencyKey, request.commandKind);
    },
    subscribeInvalidation(cb: (n: InvalidationNotice) => void): Unsubscribe {
      subscribers.push(cb);
      return () => {
        const i = subscribers.indexOf(cb);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    // ----- LocalAuthPort -----
    async setupGuardian(input: SetupGuardianInput): Promise<AuthSession> {
      return store.setupGuardian(input);
    },
    async unlockGuardian(input: UnlockGuardianInput): Promise<AuthSession> {
      return store.unlockGuardian(input.passphrase);
    },
    async enterLearner(input: EnterLearnerInput): Promise<AuthSession> {
      return store.enterLearner(input.learnerId);
    },
    async lock(): Promise<LockResult> {
      return store.lock();
    },
    async session(): Promise<AuthSession | null> {
      return store.currentSession;
    },
    // ----- DesktopPort (MOCK_ONLY behaviour) -----
    async saveExport(input: SaveExportInput): Promise<SaveExportResult> {
      return {
        saved: true,
        savedToLabel: `MOCK_ONLY 导出文件（${input.preparedExportRef.slice(0, 12)}…）`,
      };
    },
    async requestQuit(): Promise<QuitFlowState> {
      return { phase: 'COMPLETED' };
    },
    async cancelQuit(): Promise<QuitFlowState> {
      return { phase: 'CANCELLED' };
    },
    async hostStatus(): Promise<HostStatusProjection> {
      return { hostPhase: 'READY', canAcceptCommands: true, pendingUnknownCommands: false };
    },
    // ----- MOCK view extensions (named contract gaps) -----
    mock: {
      getEvaluation: (cycleId) => store.getEvaluation(cycleId) as never,
      getHints: (cycleId) => store.getHints(cycleId),
      getReviewCard: (cycleId) => store.getReviewCard(cycleId),
      getMigration: (learnerId) => store.getMigration(learnerId),
      deferMigration: (learnerId, days) => store.deferMigration(learnerId, days),
      getTimelineDetail: (attemptId) => store.getTimelineDetail(attemptId),
      listLearners: () => store.listLearners(),
      listAttempts: (learnerId) => store.listAttempts(learnerId),
      registerExplanationRevision: (cycleId) => store.registerExplanationRevision(cycleId),
      getLastDeletionScopeHash: () => store.getLastDeletionScopeHash(),
      nowMs: () => store.nowMs(),
    },
  };
  return ports;
}
