/**
 * DEV entry (MOCK_ONLY): wires the deterministic in-memory mock client
 * (same frozen contracts) so the whole player runs without the desktop Host.
 * Everything rendered from here is development evidence only — screenshots
 * must carry the MOCK_ONLY badge that this entry displays in the header.
 * Never bundled into the product build (build:web builds main.tsx only).
 */
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { App } from './App';
import { createMockRondo } from '../../../modules/mock-client';
import type { AppPorts, LearnerViewPort } from './client/ports';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

const mock = createMockRondo({
  now: () => Date.now(),
  // dropReceiptOnce: true — flip on to exercise the RECEIPT_UNKNOWN path
});

const cmdLog: Array<{ kind: string; at: number; result: string }> = [];
const loggedClient = new Proxy(mock, {
  get(target, prop) {
    if (prop === 'command') {
      return async (envelope: { kind: string }) => {
        try {
          const r = await target.command(envelope as never);
          cmdLog.push({ kind: envelope.kind, at: Date.now(), result: r.status + (r.errorCode ? ':' + r.errorCode : '') });
          return r;
        } catch (err) {
          cmdLog.push({ kind: envelope.kind, at: Date.now(), result: 'THROW:' + String(err).slice(0, 120) });
          throw err;
        }
      };
    }
    return (target as unknown as Record<string, unknown>)[prop as string];
  },
});
const ports: AppPorts = {
  client: loggedClient as typeof mock,
  auth: mock,
  desktop: mock,
  view: mock.mock as unknown as LearnerViewPort,
  isMock: true,
};
// DEV-only debugging surface (never in the product bundle): the in-page
// console can inspect the mock store and the command log.
(window as unknown as { __rondoMock: unknown }).__rondoMock = { mock, ports, cmdLog };

createRoot(container).render(
  <StrictMode>
    <App ports={ports} />
  </StrictMode>,
);
