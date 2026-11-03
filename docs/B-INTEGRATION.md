# B 线实现接入说明（A 的 Host composition 用）

B-learning 候选内 `modules/learning`、`modules/content`、`adapters/sqlite`（schema 除外）的学习域实现。本文件是服务工厂接入说明，不改变冻结契约。

## 装配（与 tests/fixtures/harness.ts 同路径）

```ts
import { createSqliteStorage, SqliteStorage } from '../adapters/sqlite/storage';
import { RondoContentService } from '../modules/content';
import { createLocalAuth } from '../modules/learning/auth';
import { createLearningServer } from '../modules/learning';
import type { LearningPolicySet } from '../modules/contracts/server/learning';

const storage: SqliteStorage = createSqliteStorage({ file: dataRootDbFile, now: () => Date.now() });
const content = new RondoContentService({ storage, now: () => Date.now() });
await content.loadRelease(contentRootDir, releaseId);          // 注册并校验 release
const auth = createLocalAuth({
  storage, time: { now: () => Date.now() }, ids,               // ids: IdGenerator（服务端生成身份）
  windowRef: trustedMainWindowRef,                             // rondo://app 受信窗口引用
  hostEpoch,                                                   // 每次 Host 启动推进（B-D4）
});
const server = createLearningServer({
  context: auth.contextProvider,                               // A 的 router 用它解析 ServerContext
  content, storage, time: { now: () => Date.now() }, ids,
  policy: registeredPolicySet,                                 // 课程图/提示策略/保留默认
});
```

启动对账（A 编排）：打开库（migration runner 自动应用并核对 schemaVersion，损坏文件直接抛错、绝不覆盖）→ `loadRelease` 登记内容并推进状态机到 AVAILABLE → 调 `applyRollingRetention(storage, { asOf, newOpId })` 执行已确认的滚动保留（仅实际执行过的清理才落 tombstone）→ hostEpoch 推进使旧会话全部失效。

## close 顺序（server-ports-recommendation §5）

1. A 冻结路由新命令；
2. `await server.close()`（幂等；新命令 `HOST_RECOVERING`，在途事务有界排空）；
3. `await content.close()`；
4. `const report = await storage.close()`（返回 `CloseReport{pendingTransactions, releasedStatements, walCheckpointed}`；WAL checkpoint TRUNCATE，B-D3）；
5. `storage.closeConnection()` 由 A 调用（连接归 A 所有）；随后 A 关闭 DSH/Host 上下文。

## 维护入口（非公开命令，Host 直接调用）

- `applyReleaseStatusChange(storage, now, { releaseId, to, reason })`：内容状态机迁移；转 REVOKED 时同事务把绑定 attempt 置 `CONTENT_BLOCKED` 并追加事件。
- `finishExport(storage, scope, { opId, outcome, savedToLabel })`：desktop saveExport 回调后收尾（COMPLETED / CONFIRMED_FAILED / FAILED）。
- `buildExportPayload(storage, scope, opId)`：产出最小导出 JSON（UTF-8，含 schema/时间/范围 hash；不含凭据/私有规则/他家庭）。
- `applyRollingRetention(storage, { asOf, newOpId })`：滚动保留清理 + 计数 tombstone。

## B 侧内部缝（fail-closed，均先做运行时能力检查）

| 缝 | 位置 | 用途 |
|---|---|---|
| `ContentServiceInternal`（getTaskSpec / getHintContent / sampleGivens / getPublicQuestionSpecFor） | `modules/content` | 学习服务读取任务规格/提示分类/确定性采样；冻结 `ContentService` 之外的能力，缺失时相关命令以 `PERSISTENCE_FAILED` 拒绝 |
| `SqliteStorage.dispose(spec)` / `findInstanceUnscopedSync` / `findReleaseStatusSync` | `adapters/sqlite/storage.ts` | 两阶段删除执行（仅 tx 内可用）；内容投影的实例/状态同步读（家庭授权由学习服务在 attempt/cycle 层执行） |
| 具体仓库扩展方法（`findByIdUnscopedSync`、`listAllByCycle`、`explanationRevision.findById`、`learningCycle.listByAttempt`、`learningAttempt.listNonTerminalUnscoped`、`dataOperation.listByFamilyAndKind`、`family.listAll`、`guardianCredential.findAny/clearFailures`） | `adapters/sqlite/repositories.ts` | 证据汇总/导出/认证引导/撤销清扫/两阶段确认；全部带文档注释与作用域纪律 |

## 关键语义决定（H0-README B 侧 8 项开放问题的最终决定）

1. **结构化预测/响应形状**：按冻结 envelope 执行（`propertyJudgments` / `objectMapping` / `numberWithUnit`；预测 claims 与 propertyJudgments 同形）。预测原文以 canonical JSON 存 `prediction.contentJson`，首次之后不可覆盖。
2. **hintLevel 上限**：整数 0..5（schema 界）；任务上限来自 `policy.hintPolicy`，且 manifest `hintGateTable` 必须为该 (task, level) 登记存在的 contentRef。提示内容文件自带 `revealsAnswer` 分类：为 true 的提示一旦展示，后续提交的 `assistanceSnapshotJson.answerHintPresented=true`，结果摘要不再标独立。
3. **空 payload 命令**：reviseResponse / beginExplanation / finishAttempt / pause / resume 维持空对象 payload，不加 reason 字段（放弃意图已由 `confirmAbandon: true` 显式表达）。
4. **actorId 建模**：GUARDIAN 会话 actorId = guardianActor 行 id；LEARNER 会话 actorId = 确定性 `learner-actor:<learnerId>`（跨会话稳定，使重登录后的同键重放收敛为一次效果）。幂等作用域 (familyId, actorId, key) 只取自 ServerContext。
5. **evaluation 更正**：schemaVersion 1 不建更正表；原始 evaluation 每 submission 唯一且不可变，更正走 reviseResponse → 新 submission（priorSubmissionId 链）。规则级更正记录需要 A 的版本化 migration（具名缺口，见交付说明）。
6. **dataOperation.phase 六值**：启用 PREPARED/CONFIRMED/CONFIRMED_FAILED/COMPLETED/FAILED；COMPLETED_PARTIAL 留给未来分批处置（B-D9 门控语义已就绪）。learner.status 二值保留，首批无归档命令。
7. **LearningPolicySet 最小集**：冻结形状（courseGraph + hintPolicy + defaultRetention）足够首批，未扩展。
8. **代录必填**：`transcribedByGuardian: boolean` 必填（冻结 schema）；为 true 时 scribeActorId 取自该学习者会话签发时的 hostSession.guardianActorId，无关联监护人则拒绝。

另两项实现决定：删除 `ALL_FAMILY_DATA` 保留 family/guardianActor/guardianCredential 行（dataOperation FK 是 tombstone 的存在前提；孩子学习数据全删）；`setRetention.confirmedPreviewVersion` = sha256(canonical({familyId, mode, rollingDays, affectedAttemptIds}))，客户端可用公开 canonicalize 从投影自算，服务端同配方复核。

## 测试入口（真实可跑）

```bash
npm run typecheck        # tsc --noEmit
npm run check:contracts  # H0 契约夹具（23 用例）
npm run test:domain      # 44 用例：认证/隔离/生命周期/幂等/判分/投影/监护
npm run test:storage     # 10 用例：schema/CAS/约束/回滚/损坏库/快照
npm run test:integration # 4 用例：断回复读/备份恢复/close/双根隔离
npm run test:b           # 以上全部（typecheck 先行）
```
