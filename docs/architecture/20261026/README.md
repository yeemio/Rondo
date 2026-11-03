> 阅读时效：下文完整保留 2026-10-26 的设计交付时点，包含当时的平台选择、授权及“尚未实现”状态。2026-10-27 已转为浏览器优先并开展课程扩充；当前目标、责任、阶段与证据从[产品合同](../../RONDO_PRODUCT_CONTRACT.md)、[生命周期地图](../../RONDO_PRODUCT_LIFECYCLE_MAP.md)和[去重目标表](../../status/RONDO-PRODUCT-TRACKER.md)读取。
> 本目录的领域/API/场景保证继续作为设计依据，旧平台顺序和待开工状态不再用于当前调度。原 readback 及外发包证明当时版本，本次入口提示不改写或重签旧证据。

# Rondo · 回旋曲：立项与架构交付

2026-10-26。**本阶段交付为可执行的产品合同、生命周期、macOS 桌面架构、场景合同和去重任务设计。产品实现尚未开始。** 当前聊天承担 Rondo 唯一主控和文档 writer；没有接管任何供体项目，也没有派发实施。

## 当前决定

Owner 在本聊天明确改为“桌面客户端优先、本地保存数据”，并指定先用当前 macOS 验证。这覆盖原始交接和规划中的浏览器首版约束；Web 界面与领域服务分离的结构保留。当前机器为 macOS arm64，其他平台与独立浏览器发行后续另定。

Metis 架构参考、DSH 底座、three.js 教学交互保持确定。新方案为 Electron 桌面壳 + 最小 DSH 本地 Host + Rondo 服务端学习领域 + SQLite + React/three.js 与 SVG/DOM 等价表达。构题、答案、判分、提示和学习事实由 Host 掌握，通用 DSH 工具不向孩子开放。

能力先修主线、“给小店设计一个圆筒”八课和先做两课仍是规划建议，本阶段按它们完成可逆设计；没有把规划接收写成 Owner 逐项批准。推荐下一批为 **R0 → R1 → R2：当前 Mac 上前两课的完整学习流程，步骤卡与离线 AI，零真实模型调用**。

## 阅读与实施入口

| 文件 | 解决的问题 |
|---|---|
| [PRODUCT-CONTRACT.md](PRODUCT-CONTRACT.md) | 人群、学习目标、能力图、八课、孩子/监护旅程、首批范围、可观察验收 |
| [LIFECYCLE-DATA-API.md](LIFECYCLE-DATA-API.md) | 内容/attempt/cycle/提交/提示/未知/恢复；公开 API；家庭权限；导出、保留和删除 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 桌面/Host/DSH 分工、工程路径、精确输入版本、数据根、运行与升级、C++ 和未来提案边界 |
| [SCENE-CONTRACTS.md](SCENE-CONTRACTS.md) | 八课对象/参数/动作/反馈；前两课精确合同；键盘/降级；领域状态与渲染分离 |
| [DELIVERY-PLAN.md](DELIVERY-PLAN.md) | 每项资产复用/适配/重做/延期；R0–R5 依赖、允许路径、责任、验收与停止条件 |

根 [README](../../../README.md)和 [AGENTS](../../../AGENTS.md)已指向本入口。[原始交接](../../handoff/START-HERE.md)增加最新平台决定，原交接正文保留历史信息；两份规划原件没有改写。

## 有效事实与本阶段取证

| 项目 | 结果与准确边界 |
|---|---|
| 需求原件 | SHA-256 `773a3d8c34c94ef31de98aee076f5ae05036615eec8a592eea480d4fa2092f48` |
| 完整规划原件 | SHA-256 `aa77fa28c7be5341d315bb8cfd5e95b7c7d71859f2e10e2d5177b7fffe3c5e21` |
| 供体定向读取 | Metis 架构/公共接口/桌面与 Host；OwlCodaE 组合与 DSH 公共包；圆柱 PoC；路径、字节身份与局部包核对见 [source-readback.json](evidence/source-readback.json) |
| 新发现的供体差异 | 六课 PoC 及 17 步报告已存在；仍是前端演示判分、本机进度和不完整降级。未重跑或接受为 Rondo 产品 |
| Node 兼容探针 | Node `24.18.0`、SQLite `3.53.1`，DSH 公共 HTTP 接缝与合成持久读回通过；见 [结果](evidence/dsh-public-consumer-result.json) |
| 桌面运行时局部探针 | Electron `44.7.0` 的 Node 模式，实际 Node `24.21.0`、SQLite `3.53.4`，同一 consumer 通过；见 [结果](evidence/electron-public-consumer-result.json) |
| 探针保护边界 | 只读解析供体现有依赖，公开包入口与 tarball 的所选文件相符；临时合成数据库已清理，监听已关闭；未运行供体 App 或真实 provider |
| 文档最终读回 | 原件、内部引用、设计任务图与保护源核对见 [architecture-readback.json](evidence/architecture-readback.json)；这是文档证据，不是产品测试 |

探针源码为 [dsh-public-consumer-probe.mjs](evidence/dsh-public-consumer-probe.mjs)，源码身份记在 source-readback；它的用途是确认公共接缝和两个实际 Node 运行时的局部消费，不是长期产品实现。

## 交接八项设计要求的落点

| 交接要求 | 已形成的具体设计 |
|---|---|
| 产品合同 | 产品合同 §1–10：目标/建议强度、必做/延期、学习者结果与验收层次 |
| 生命周期 | 生命周期 §1–4、§10：内容、尝试/轮次、提示、提交、送达未知、桌面与延迟迁移 |
| 新架构 | 架构 §1–6：唯一 owner、DSH 公开接合、UI/领域/存储/执行依赖 |
| 工程方案 | 架构 §4、§7–8：目录/单根锁、已核输入候选、待实现脚本、数据根与升级 |
| 数据与权限 | 生命周期 §5–9：公开/私有协议、监护身份、家庭隔离、事务回执、数据治理 |
| 场景交互 | 场景合同 §1–8：前两课细化、后六课完整边界、鼠标/键盘/降级与数值口径 |
| C++ | 架构 §9：成熟编译器、独立本机隔离 worker、限额/未知/取消、有限步进；R4 接受条件 |
| 复用与任务 | 实施表 §1–6：准确来源、处置、去重 DAG、允许路径、单 writer 与阶段停止 |

## 未被本阶段证明的事项

Rondo 独立依赖安装、完整锁文件、DSH public boot 与 Rondo profile、实际桌面窗口/preload/utilityProcess、业务权限与崩溃恢复、课程产品运行、完整二维降级、C++ 隔离、真实学习效果、签名/部署/市场或商标结论均未完成。不能用供体的测试数或本次两个局部 consumer 结果替代。

Git 保持已初始化、无提交/远程；本次没有 add/commit/push/PR。没有安装全局依赖、启动容器/VM、改供体、调用付费模型或传输儿童数据。没有建立第二主控、迁移旧 RunKit 或启动严格 TDD。

## 唯一下一动作

**确认并授权 DELIVERY-PLAN 中 R0–R2 的 macOS 两课实施范围及投入上限，然后从 R0 开始。** 本阶段已达到交接设定的合同/架构停止条件，不继续制造规划或自动转入产品实现。

真实 C++/考级意愿、家庭节奏与真实数据政策可在对应实施/试用边界前补充；不需要再选择 DSH、three.js 或首个操作系统。
