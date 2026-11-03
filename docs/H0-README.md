# H0 公共契约基线 README

H0 是 Rondo R0–R2 批次三条实施线（A/B/C）的共同父身份基线。本目录由 A 线按 `../preparation/A/H0-SPEC.md`（v0.2，含 §7 对 B 线 B-D1..B-D10 的全采纳裁定）组装冻结；独立验收（code-reviewer，同族记账）已 ACCEPT。

## 结构

- `modules/contracts/public/**`：renderer 可见契约（envelope 23 命令判别联合、receipts、queries 10 项、client、auth、desktop、question、scene、errors 12 码、canonical）。禁止 import server/sqlite/Node API。
- `modules/contracts/server/**`：服务端契约（context、learning 工厂签名、content、rules、storage 端口、scene-canonical）。不可进 renderer bundle。
- `adapters/sqlite/schema/**`：唯一 DDL 位置（21 业务表 + schema_migrations，schemaVersion=1）。
- `tests/contracts/**`：合成往返夹具 + 负例 + canonical 测试（node --test + esbuild，零测试框架）。
- `vendor/dsh/0.2.1-rc.2.owlcoda.1/**`：DSH 闭包 12 tarball + SHA256SUMS（12/12 验哈希），供 A 平台候选消费，H0 本身不安装。
- `toolchain.json`：build/runtime 身份实测记录。
- `H0-IDENTITY.json`：四 hash（contracts/schema/lock/source-manifest）与 digest 口径。

## 脚本（真实入口）

```bash
npm ci                     # 独立锁重建
npm run typecheck          # tsc --noEmit
npm run check:contracts    # esbuild 打包 + node --test
```

锁定：typescript 5.8.3 / esbuild 0.28.2 / zod 3.25.76（唯一运行时校验依赖，dependencies）/ @types/node 24.19.2。

## B/C 消费方式

从本 H0 新建各自物理副本（B-learning/、C-experience/），共享文件只读；新增依赖或 API/schema 变化回 A 单点处理（A 发有版本 delta，B/C 吸收具名文件并记录新父身份）。

## 实施期收敛的开放问题（不阻塞本基线）

B 侧 8 项：结构化预测/响应形状草案确认、hintLevel 上限、空 payload 命令是否加 reason、learner 角色 actorId 建模归属、evaluation 更正记录与 submissionId UNIQUE 共存、dataOperation.phase 六值与 learner.status 二值确认、LearningPolicySet 最小字段、saveExplanation 代录标识必填。
C 侧 6 项：AuthoredBlocks 四块与 FORMULA.expression 语义、量规词表、KeyboardCommandMap 结构、effectRefs `<type>:<id>` 约定、DesktopPort 枚举、responseSchemaId 命名空间。

## pending-C 标记

B-D10 私有规则 DSL 的 JSON schema 以本基线草案为准（L1 参数识别 / L2 数值关系两族，π=157/50，无字符串执行）；C 线 preparation 到达后经具名 delta 对齐定稿。
