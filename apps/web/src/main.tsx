/**
 * PRODUCT entry. Two real transports, no mock:
 * - desktop: the preload injects window.rondo (A lane, rondo://app);
 * - browser: the page is served by the Host's web gateway over http(s) and
 *   the same fixed faces run over same-origin HTTP (client/http-transport).
 * The mock client is NOT part of this graph — dev isolation uses
 * main.dev.tsx (built by npm run build:web:mock, labeled MOCK_ONLY).
 */
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { App } from './App';
import { productPorts, browserPorts } from './client/ports';
import type { AppPorts } from './client/ports';
import './styles.css';
import './studio/approved-studio.css';
import './studio/approved-cpp.css';
import './studio/math-scoped.css';
import './studio/studio-extension.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
try {
  const isHttp = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  const hasPreload = (window as unknown as { rondo?: unknown }).rondo !== undefined;
  const ports: AppPorts = hasPreload
    ? productPorts()
    : isHttp
      ? browserPorts()
      : (() => {
          throw new Error('产品入口需要桌面 preload（window.rondo）或本机 HTTP 服务。开发请运行 npm run build:web:mock（MOCK_ONLY）。');
        })();
  createRoot(container).render(
    <StrictMode>
      <App ports={ports} />
    </StrictMode>,
  );
} catch (err) {
  container.innerHTML = `<div class="app-root"><section class="card"><h2>学习书暂时没有打开</h2><p>${
    '请确认本机学习服务已启动，再重新打开页面。'
  }</p><p>你的学习记录仍保留在这台电脑上。</p></section></div>`;
}
