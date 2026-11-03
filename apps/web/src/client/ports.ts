/**
 * AppPorts: what the UI consumes. Three frozen narrow interfaces
 * (RondoClient / LocalAuthPort / DesktopPort) plus the optional LearnerViewPort
 * for read needs the frozen projection catalog cannot express yet.
 *
 * integrated/ wiring note (A lane): the view port is now an ASYNCHRONOUS
 * typed port (ipcRenderer.invoke semantics of the real desktop channel);
 * the dev mock (main.dev.tsx) still satisfies it through a cast since its
 * in-memory store is synchronous. All view payload types live in
 * adapters/desktop-client/view-port.ts (renderer-safe) so the adapter and the
 * UI share one definition.
 */
import type { RondoClient } from '../../../../modules/contracts/public/client';
import type { LocalAuthPort } from '../../../../modules/contracts/public/auth';
import type { DesktopPort } from '../../../../modules/contracts/public/desktop';
import { createRondoClient, createLocalAuthPort, createDesktopPort } from '../../../../adapters/desktop-client';
import { createLearnerViewPort } from '../../../../adapters/desktop-client/view-port';
import type { RondoBundlePreloadApi } from '../../../../adapters/desktop-client/preload-api';
import { createHttpFaces } from './http-transport';

export type {
  EvaluationItemView,
  EvaluationView,
  HintView,
  ReviewCardView,
  MigrationCardView,
  TimelineEventDetail,
  TimelineDetailView,
  AttemptListItemView,
  LearnerViewPort,
} from '../../../../adapters/desktop-client/view-port';

export interface AppPorts {
  client: RondoClient;
  auth: LocalAuthPort;
  desktop: DesktopPort;
  /** absent in a product build whose preload lacks the view face (old hosts) */
  view?: import('../../../../adapters/desktop-client/view-port').LearnerViewPort;
  /** A-owned diagnostics surface; used for the structured entry-routing signal */
  platform?: { info(): Promise<{ guardianConfigured?: boolean }> };
  isMock: boolean;
}

/** Shared face -> ports mapping (identical adapters for preload and HTTP faces). */
function facesToPorts(api: RondoBundlePreloadApi): AppPorts {
  return {
    client: createRondoClient(api.client),
    auth: createLocalAuthPort(api.auth),
    desktop: createDesktopPort(api.desktop),
    ...(api.view ? { view: createLearnerViewPort(api.view) } : {}),
    ...(() => {
      const platformApi = api.platform;
      return platformApi
        ? {
            platform: {
              info: async () => {
                const r = await platformApi.info();
                if (r.ok) return r.value as { guardianConfigured?: boolean };
                throw new Error(r.error.message);
              },
            },
          }
        : {};
    })(),
    isMock: false,
  };
}

/** Product wiring: the desktop preload injects window.rondo (A lane). */
export function productPorts(): AppPorts {
  const w = window as unknown as { rondo?: RondoBundlePreloadApi };
  if (!w.rondo) {
    throw new Error('产品入口需要桌面 preload（window.rondo）。开发请使用 main.dev.tsx（MOCK_ONLY）。');
  }
  return facesToPorts(w.rondo);
}

/**
 * Browser product wiring: same fixed faces over the local HTTP gateway
 * (same-origin fetch; the mock client is NOT in this graph). Used when the
 * page is served over http(s) without a desktop preload — never a silent
 * mock fallback.
 */
export function browserPorts(): AppPorts {
  return facesToPorts(createHttpFaces());
}
