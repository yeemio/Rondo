# integrated/ 深接线规格（A 线整合 writer 用，2026-10-27 限额窗口定稿）

状态：SPEC_READY——机械叠加已完成（三线文件+依赖/脚本/tsconfig 合并+mock-client 补齐+根锁统一+typecheck exit 0），本文件描述剩余接线，供一个实施代理一次性完成。父身份：H0 `h0-20261027-1`；来源 A `a-platform-r0-20261027-001`、B `b-learning-r1-20261027-001`、C `c-experience-r2-20261027-001`。

## 0. 已完成基线（勿重做）

integrated/ = A-platform 全树 + B 的 modules/learning、modules/content、adapters/sqlite/{connection,migrations,repositories,storage,disposal,sql-modules.d.ts}、tests/{domain,storage,integration,fixtures}、docs/B-INTEGRATION.md + C 的 content/、modules/scenes、modules/mock-client、apps/web、tests/{content,scenes,learning-flow}、scripts/{build-content,build-web}.mjs。package.json 16 deps/8 devDeps/20 scripts（含 check:all）、tsconfig 并集、npm install 已统一 lock、typecheck exit 0。

## 1. Host 真实装配（新文件 apps/host/services/learning-wiring.ts）

- cordis Service `rondoLearning`，profile/cordis.yml 的 sqlite-adapter 条目替换为 `./services/learning-wiring.mjs`（composition 审计自动跟随；activeServices 仍恰 2 项）。
- 单连接原则：**删除 A 的 RondoSqlite 连接**（避免双连接双 writer）；B 的 `createSqliteStorage({ file, now })` 自带 migration runner 与 schemaVersion 断言，成为唯一连接。
- 装配顺序按 B-INTEGRATION §装配：storage → `RondoContentService({storage, now})` → `content.loadRelease(contentRoot, releaseId)`（两个 release l1-r1/l2-r1 都登记）→ `createLocalAuth({storage, time, ids, windowRef, hostEpoch})` → `createLearningServer({context: auth.contextProvider, content, storage, time, ids, policy})`。
- policy：从 content 的 release manifest 推导最小 LearningPolicySet（courseGraph 按 C 的 lessons.json/tasks 结构、hintPolicy 用 manifest hintGateTable、defaultRetention 按 LIFECYCLE §9 建议 180 天滚动但显示为「建议值」）。
- contentRoot：新 env `RONDO_CONTENT_ROOT`（Main 传打包内容目录；dev 构建指向项目 content/ 产物）。加入 host-supervisor 的 env 白名单与 runtime.ts。
- 启动对账按 B-INTEGRATION §启动对账：开库→loadRelease→applyRollingRetention→（hostEpoch 已在 main.ts 推进）。
- main.ts 适配：identity.sqliteVersion 改由 rondoLearning 提供（B storage 或连接读取）；RECOVERING 恢复核验改调 rondoLearning 的 verifyRecovery（B storage 断言）；shutdown 序列改为 B-INTEGRATION §close 顺序：router.freeze → `server.close()` → `content.close()` → `storage.close()`（取 CloseReport 记日志）→ `storage.closeConnection()` → disposeHostTree → exit。host-db-closed 日志保留（带 CloseReport）。

## 2. ipc-router 真实 handler（改 apps/host/services/ipc-router.ts）

- 构造器不再调用 registerR0Handlers（R0 占位仅存在于 A-platform 候选；integrated 移除占位路径）。
- learning-wiring 在服务初始化时注册全部 ROUTER_OPS：command→`server.handleCommand(authCtx(sessionRef,windowRef), envelope)`、query→server.query、receipt→server.lookupReceipt、auth.*→auth 端口五操作。信封/查询仍先过 frozen zod（router 已有）。
- router 增加 `assertAllOpsRegistered()`（初始化完成后核 handlers 覆盖 ROUTER_OPS+view ops，缺失即抛→拒 READY）。
- 新增 VIEW_OPS 闭集（对应 C 的 LearnerViewPort，apps/web/src/client/ports.ts）：`view.getEvaluation/getHints/getReviewCard/getMigration/getTimelineDetail/listLearners/listAttempts/registerExplanationRevision/getLastDeletionScopeHash/nowMs`。实现用 B 的公开查询 + B-INTEGRATION §内部缝（getTaskSpec/getPublicQuestionSpecFor/explanationRevision.findById/learningCycle.listByAttempt/dataOperation.listByFamilyAndKind/listLearners 等）；投影形状以 C 的 mock-client（modules/mock-client/store.ts/evaluator.ts）为准逐字段对齐——mock 与真实实现的投影必须同形，C 的 UI 才能两态通用。鉴权同 command（guardian-only 的视图按角色拒）。

## 3. 桌面侧通道（apps/desktop/ipc-routes.ts + preload.cts + adapters/desktop-client）

- ipc-routes 增加 10 个具名通道 `rondo:view:<op>`（同现有 13 通道的 sender/frame/origin 断言 + zod 负载校验），转发 host。
- preload.cts 增加 `exposeInMainWorld('rondo', { client, auth, desktop, view })`：client/auth/desktop 三面复用现有 Rondo/RondoAuth/RondoDesktop 实现；view 按 op 闭集转 ipcRenderer.invoke。C 的 productPorts() 期望 `window.rondo`（见其 ports.ts L94-107）。
- adapters/desktop-client 增加对应 transport（若其 mapping 需要新通道注册表）。

## 4. 构建与内容（tooling/build.mjs + scripts/build-web.mjs/build-content.mjs）

- root build 的 web 步骤切到 C 的入口 apps/web/src/main.tsx（product 模式，排除 mock：C 的 build-web.mjs 已区分 product/mock——统一入口，root build 调 product 路径逻辑；index.dev/main.dev 不进 product 产物）。
- build 后运行 scripts/build-content.mjs 产 dist/content（含 public+private；Host 读全部）；**renderer 协议 rondo://app 只映射 dist/web 与 public 资源，绝不映射 content/private**（main.ts 协议 handler 的包含性校验保持，路径集显式排除 dist/content/private）。
- 探针页 fixtures 化：A 原探针页（apps/web/src/main.tsx 的 __rondoSelfTest）移 tests/desktop/fixtures/probe/，仅当 env `RONDO_BUILD_PROBE=1` 时构建到 dist/web/__probe/；check:desktop/check-desktop-hardening 的 harness 以 `rondo://app/__probe/index.html` 加载探针（transport 层自检与真实 UI 解耦）；package:mac 不设该 env（探针不进产品候选）。check-desktop.mjs 增补一项：产品入口 `rondo://app/index.html`（C 的 UI）加载成功且 window.rondo 三面存在。

## 5. 验证门（接线完成后必须全绿，真实命令+退出码）

1. `npm run typecheck` exit 0
2. `npm run check:all`（contracts 23 + desktop 17 + domain 44 + storage 10 + integration 4 + content 11 + scenes 10 + learning-flow 8 + boundaries——boundaries 扫描需把 modules/mock-client 与 apps/web 的 mock 入口列为 dev-only 白名单，product bundle 不得含 mock）
3. `npm run check:desktop`（含探针 9 项 + 产品入口加载项 + Host identity 新来源）
4. `npm run check:desktop-hardening` 34 项不削弱
5. `npm run dev:desktop` 烟测：真实窗口走 C 的 UI——setupGuardian→enterLearner→L1 引导任务一题全流程（预测→操作→提交→反馈→解释）+ 监护时间线读回（此为 R1/R2 证据的预演，正式证据由 A 主线程录制）
6. 出现 B/C 契约缺口：停在该点回传 CONTRACT_CHANGE_REQUIRED 具名，不绕过

## 6. 边界

- 冻结只读不变：modules/contracts/**、adapters/sqlite/schema/**；B/C 业务源码原则上原样消费，接线必需的最小适配（如 view 投影补字段）逐条记录 changed path 与理由，返工回原 writer 确认。
- 无 Git、不动 .work 之外/供体/实施包；产品候选不含 mock 与探针。
