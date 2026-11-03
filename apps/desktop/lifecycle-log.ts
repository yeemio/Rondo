/**
 * Desktop Main structured lifecycle log (JSON lines under the data root's
 * technical/logs). Sanitized facts only — versions, epochs, phases, exit
 * codes, timings; never request payloads or child content.
 *
 * The desktop check harness reads this file as its evidence stream.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LifecycleEvent =
  | 'app-start'
  | 'window-created'
  | 'host-fork'
  | 'host-ready'
  | 'host-exit'
  | 'host-response-dropped'
  | 'host-boot-failed'
  | 'quit-flow'
  | 'app-exit'
  | 'ipc-sender-denied';

export class LifecycleLog {
  constructor(private readonly logsDir: string) {
    mkdirSync(logsDir, { recursive: true });
  }

  write(event: LifecycleEvent, facts: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: Date.now(), event, ...facts });
    try {
      appendFileSync(join(this.logsDir, 'desktop-lifecycle.log'), `${line}\n`);
    } catch {
      // A failing diagnostics log must never take the app down.
    }
  }
}
