# Rondo SQLite schema（A 线所有，schemaVersion = 1）

`adapters/sqlite/schema/**` 是全项目唯一允许出现 SQLite DDL 的位置（SHARED-CONTRACT 唯一文件 owner 表）。B 的 repository 实现不得在任何其他目录内嵌另一份建表语句。

## 当前内容

- `0001_init.sql`：初版全部 21 张业务表 + `schema_migrations`，按 preparation/B/sqlite-schema-recommendation.md §2 表组与 §3 索引清单落盘。**不含 code job 表组**（B-D7：首批 `code.requestRun/requestCancel` 一律 `CAPABILITY_UNAVAILABLE`，启用真实能力时由 A 发版本化 migration）。
- `schemaVersion.ts`：`SCHEMA_VERSION = 1`，adapter 打开时核对，不匹配报 `SCHEMA_MISMATCH`。

## Migration 约定

1. 文件名 `NNNN_name.sql`，编号只增、单调、永不重排；已交付的 migration 文件永不修改，修正走新编号文件。
2. 每个 migration 在**单事务**内应用，同一事务内写入 `schema_migrations(version, name, appliedAt)`；任何一步失败整体回滚，数据库不留下半应用状态。
3. `schemaVersion.ts` 的值必须等于已应用的最大 migration 编号，两者同一次变更内一起更新。
4. repository 初始化不得内嵌 DDL；运行期 `CREATE TABLE` 一律禁止。
5. 破坏性变更（删除/重建列）必须先经内容与数据兼容性评估；儿童学习数据优先保读回，不静默丢弃。

## 连接与事务约定（adapter 每连接执行，不写进 DDL）

- `PRAGMA journal_mode = WAL;`
- `PRAGMA foreign_keys = ON;`
- `PRAGMA synchronous = FULL;`（B-D3：回执返回 ⇒ 事实已 fsync。若未来改 NORMAL，必须在 H0 记录断电窗口语义。）
- 写事务一律 `BEGIN IMMEDIATE` 短事务（`StoragePort.tx`），长操作、编译与模型调用不得占写事务；读走 `StoragePort.read` 只读路径。
- 所有 SQL 使用绑定参数；身份全部由服务端生成（ULID / uuid v7 形式文本串）。

## 数据形态约定

- 时间戳：INTEGER epoch 毫秒，服务端时钟（`LearningServerDeps.time`），不用客户端时钟排序。
- seq：INTEGER，服务端按 attempt 单调递增；`learningEvent(attemptId, seq)` UNIQUE。
- 结构化负载（事件 payload、响应原文、快照）：canonical JSON 文本列；身份/scope/枚举/版本/seq 永远是独立列。
- `learningEvent.payloadVersion` 初始 `'1'`（B-D8），投影按事件类型 + 版本解析。
- 关键约束：`commandReceipt(familyId, actorId, idempotencyKey)` 复合主键 + `payloadHash`（同键异 hash = `IDEMPOTENCY_CONFLICT` 的存储基础）；`prediction` 与 cycle 1:1（主键即 cycleId）只插不改；`evaluation.submissionId` UNIQUE（每 submission 一个原始 evaluation）；`learningAttempt.version` 是唯一 CAS 点（B-D1）。
- `0001_init.sql` 中 `schema_migrations.appliedAt` 的占位 0 会被 migration runner 用真实服务端时钟覆盖写入。
