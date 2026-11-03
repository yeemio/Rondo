# Rondo · 回旋曲

面向孩子的数学、逻辑推理与 AI 通识学习产品。浏览器界面连接本机 DSH Host，学习数据保存在本地 SQLite；React 负责界面，three.js 负责适合空间表达的教学交互。

当前代码基线为 `rondo-learning-flow-20261031-r1`：包含数学教学活动、GESP C++ 二级题目、AI 通识活动，以及选课、暂停继续、编辑保存、监护人导出和数据管理。全题学生体验测试仍在进行，已发现的教学内容、交互及执行环境问题尚未全部修复。本仓库的代码上传不代表学习效果验收或正式发行。

## 本地运行

使用 `toolchain.json` 中冻结的版本：Node.js `24.18.0`、npm `12.0.1`。依赖由 `package-lock.json` 锁定，DSH 的本地依赖包保存在 `vendor/`，原许可证保留在包内。

```sh
npm ci
npm run typecheck
npm run build
RONDO_DATA_ROOT="$PWD/.local-data" npm run start:web
```

在浏览器打开 <http://127.0.0.1:47623/>，首次进入时自行设置监护口令和学习者。服务仅监听本机回环地址。`.local-data/` 是本机数据目录，不进入 Git；请自行保管口令和数据备份。

构建会生成 `dist/host`、`dist/web`、`dist/content` 和桌面相关产物。当前交付顺序为浏览器优先，桌面打包后置。不要在已有服务占用同一端口或同一学习库时重复启动。

## C++ 执行

C++ 工作台使用本机 OrbStack 的 `orbstack` Docker context 与 `workers/cpp/worker-lock.json` 锁定的 Linux arm64 编译器镜像。必须预先具备该精确镜像；普通构建与 Web 启动不会自动安装 OrbStack、拉取或构建镜像。环境不满足时，编程执行能力不可用，其余课程可独立使用。

编译器约定为 GNU g++ 13.2.0、C++11。学生程序通过现有隔离 worker 执行，服务端保管判分规则；有限登记用例通过不代表对任意输入的正确性证明。AI 通识活动使用固定教学材料，不调用在线大模型。

## 目录与文档

- `apps/web/`：浏览器学习界面；`apps/host/`：本机服务；`apps/desktop/`：桌面入口。
- `modules/`、`adapters/`：领域逻辑、公共契约、存储与传输适配。
- `content/`、`apps/web/public/gesp/`：教学内容、服务端规则及题面来源材料。
- `workers/cpp/`：C++ 执行 worker 与精确镜像身份。
- `tests/`：项目检查；`scripts/`、`tooling/`：内容与应用构建。

产品范围见 [产品合同](docs/RONDO_PRODUCT_CONTRACT.md)、[生命周期地图](docs/RONDO_PRODUCT_LIFECYCLE_MAP.md)和[目标表](docs/status/RONDO-PRODUCT-TRACKER.md)。架构起点见 [架构设计基线](docs/architecture/20261026/README.md)。文档中的历史交付路径和本机证据不随仓库发布，历史状态不代表当前服务在线。

## 常用检查

```sh
npm run typecheck
npm run check:contracts
npm run check:boundaries
```

仓库包含项目源码、教学素材、精确依赖包与必要文档。本机学习库、会话和口令、测试现场、历史候选、恢复副本和生成产物保留在本地。
