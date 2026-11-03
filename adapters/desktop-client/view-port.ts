/**
 * LearnerViewPort: the renderer-side view channel adapter (A lane, R2 wiring).
 *
 * The frozen preload IPC surface is asynchronous by nature
 * (ipcRenderer.invoke), so the port methods are Promise-returning. The view
 * payload shapes mirror C's LearnerViewPort (apps/web/src/client/ports.ts)
 * field-for-field so the mock client and the real desktop transport stay
 * interchangeable for the UI.
 *
 * Renderer-safe: no Electron, no Node imports; the only validation is the
 * IpcResult unwrap (the payloads themselves are view projections outside the
 * frozen zod catalog by design — C report named-gap channels).
 */
import type { IpcResult } from './ipc-result';
import type { RondoViewPreloadApi } from './preload-api';

export interface EvaluationItemView {
  key: string;
  label: string;
  verdict: string;
  feedback?: string;
}

export interface EvaluationView {
  submissionId: string;
  seq: number;
  atMs: number;
  verdict: 'CORRECT' | 'REVISE';
  itemResults: EvaluationItemView[];
  diagnostics: string[];
  answerAssistanceActive: boolean;
}

export interface HintView {
  level: number;
  text: string;
  marksAnswerAssistance: boolean;
  atMs: number;
}

export interface ReviewCardPredictionView {
  claims: Array<{ propertyId: string; direction: string }>;
  uncertain: boolean;
  explanation?: string;
  atMs: number;
}

export interface ReviewCardView {
  taskId: string;
  taskTitle: string;
  phase: string;
  prediction: ReviewCardPredictionView | null;
  submissions: Array<{ submissionId: string; seq: number; verdict: string; atMs: number }>;
  evaluation: { verdict: string; itemResults: EvaluationItemView[] } | null;
  reveal: Record<string, string> | null;
  hints: Array<{ level: number; marksAnswerAssistance: boolean }>;
  assistance: Array<{ category: string; note: string; atMs: number }>;
  snapshot:
    | { radiusMm: number; heightMm: number; unrollPermille: number; section: string; selectedFaceIds?: string[]; layerCount?: number; visibleLayerCount?: number }
    | { rows: number; cols: number; filled: number }
    | { program: unknown[]; inputs: Record<string, number>; cursorStep: number };
  initialState:
    | { radiusMm: number; heightMm: number }
    | { rows: number; cols: number; filled: number }
    | { program: unknown[]; inputs: Record<string, number>; cursorStep: number };
  /** 微课诊断判定（服务端事实；THEMES-A delta 2026-10-27，integration W1 家族化）。PASS → 补充活动可跳过。 */
  diagnosis?: { outcome: 'PASS' | 'SUPPLEMENT'; supplementTaskId: string; atMs: number } | null;
}

export interface MigrationCardView {
  state: string;
  taskId: string;
  taskTitle: string;
  plannedAtMs: number;
  availableAtMs: number;
  nominalEndDays: number;
  remainingDays: number;
  startedAtMs?: number;
  observedAtMs?: number;
  actualIntervalDays?: number;
}

export interface TimelineEventDetail {
  eventId: string;
  seq: number;
  eventType: string;
  commandKind: string;
  occurredAtMs: number;
  payload?: Record<string, unknown>;
}

export interface TimelineDetailView {
  attemptId: string;
  status: string;
  events: TimelineEventDetail[];
}

export interface AttemptListItemView {
  attemptId: string;
  learnerId: string;
  releaseId: string;
  status: string;
  version: number;
  startedAtMs: number;
  finishedAtMs?: number;
}

/** Async LearnerViewPort over the closed `rondo:view:<op>` channel set. */
export interface LearnerViewPort {
  getEvaluation(cycleId: string): Promise<EvaluationView | null>;
  getHints(cycleId: string): Promise<HintView[]>;
  getReviewCard(cycleId: string): Promise<ReviewCardView>;
  getMigration(learnerId: string): Promise<MigrationCardView | null>;
  getTimelineDetail(attemptId: string): Promise<TimelineDetailView>;
  listLearners(): Promise<Array<{ learnerId: string; alias: string }>>;
  listAttempts(learnerId?: string): Promise<AttemptListItemView[]>;
  registerExplanationRevision(cycleId: string): Promise<string>;
  getLastDeletionScopeHash(): Promise<string | null>;
  nowMs(): Promise<number>;
}

function unwrap<T>(result: IpcResult<unknown>): T {
  if (result.ok) return result.value as T;
  throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), {
    code: result.error.code,
    rondo: result.error,
  });
}

export function createLearnerViewPort(api: RondoViewPreloadApi): LearnerViewPort {
  return {
    async getEvaluation(cycleId) {
      return unwrap<EvaluationView | null>(await api.getEvaluation({ cycleId }));
    },
    async getHints(cycleId) {
      return unwrap<HintView[]>(await api.getHints({ cycleId }));
    },
    async getReviewCard(cycleId) {
      return unwrap<ReviewCardView>(await api.getReviewCard({ cycleId }));
    },
    async getMigration(learnerId) {
      return unwrap<MigrationCardView | null>(await api.getMigration({ learnerId }));
    },
    async getTimelineDetail(attemptId) {
      return unwrap<TimelineDetailView>(await api.getTimelineDetail({ attemptId }));
    },
    async listLearners() {
      return unwrap<Array<{ learnerId: string; alias: string }>>(await api.listLearners({}));
    },
    async listAttempts(learnerId) {
      return unwrap<AttemptListItemView[]>(await api.listAttempts(learnerId === undefined ? {} : { learnerId }));
    },
    async registerExplanationRevision(cycleId) {
      // The host op resolves the bare revision id string (mock baseline and
      // LearnerViewPort contract parity) — no { revisionRef } envelope.
      return unwrap<string>(await api.registerExplanationRevision({ cycleId }));
    },
    async getLastDeletionScopeHash() {
      return unwrap<string | null>(await api.getLastDeletionScopeHash({}));
    },
    async nowMs() {
      return unwrap<number>(await api.nowMs({}));
    },
  };
}
