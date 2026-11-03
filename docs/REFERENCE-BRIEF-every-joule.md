# 设计研究简报：Every Joule（iamtechartist.com）→ Rondo 可交互立体学习书

- 研究对象：Every Joule — "A 3D physics book about energy"（GCSE/IGCSE 能量专题，十课）
- 站点：落地页 https://iamtechartist.com/every-joule/ ；应用本体 https://iamtechartist.com/Apps/every-joule/
- 研究日期：2026-10-27。研究方式：WebFetch 文本抓取（含 jina 渲染代理、W3C 验证器 API 服务端抓取）、对官方发布截图的只读视觉分析。未使用浏览器自动化，未改动任何代码。
- 证据分级标记：
  - **[CSS]** = 逐字取自官方样式表 `assets/common-DQacebU9.css`（精确值，可直接实现）
  - **[TXT]** = 逐字取自页面渲染文本（落地页 / 教师页 / 来源页）
  - **[IMG]** = 取自官方发布截图（every-joule-og.jpg 为应用真实书页截图；色值为视觉估计，标注"估"）
  - **[INF]** = 由以上证据推断（已注明推断链）
  - **[未证]** = 多种途径尝试后仍无法取证（附失败记录）
- 诚实声明：应用为 WebGL SPA，其 JS bundle 与运行时行为未能直接取证（见 §7 失败记录）。凡涉及 three.js 用法、镜头动画参数等运行时细节，本文一律标 [未证] 或 [INF]，不编造。视觉粒度要求（色值/字号/线宽）凡有 [CSS] 证据的均为原文，[IMG] 的为估计值并明示。

---

## 1. 站点结构地图（要求 a）

### 1.1 页面序列 [TXT]

| 页面 | URL | 作用 | 渲染方式 |
|---|---|---|---|
| 落地卡页 | `https://iamtechartist.com/every-joule/` | 介绍 + "Open anyway →" 跳转应用；含 WebGL 能力警告 | WordPress 静态 |
| 应用本体 | `https://iamtechartist.com/Apps/every-joule/`（即 index.html） | 十课立体书；无 WebGL 时整页降级为提示页 | WebGL SPA；无 WebGL 时显示 fallback |
| 教师页 | `.../Apps/every-joule/teachers.html` | 十课教学笔记；**纯文本、无 WebGL 也可用** [TXT: "the teachers' page and lesson text remain accessible without 3D graphics"] | JS 渲染文本 |
| 来源页 | `.../Apps/every-joule/sources.html` | "Every number in this book comes from a published source"，63 sources / 145 values，每个值附原文引句与读取日期（2026-10-21） | JS 渲染文本 |
| 深链 | `index.html#spread-1` … `#spread-10` [TXT] | 教师页逐课深链直达某一"跨页"（spread） | hash 锚点 |

同一作者的其他作品共用"章节式书本"骨架：Two Hearts（六章、hologram 对比）、Wind-Up Parade、F1 2026（Press · Burn · Harvest · Boost）[TXT: demos 列表页]。

### 1.2 十课清单（标题 / 核心式 / 关键词）[TXT]

| # | 课名 | 核心式 | 关键词（Lesson 1 例） |
|---|---|---|---|
| 1 | Energy stores | Ep = mgh | system · energy store · pathway · joule (J) |
| 2 | Up and down | Ek = ½mv² | |
| 3 | Stretch and launch | Ee = ½ke² | |
| 4 | The bouncing ball | Ep = mgh | |
| 5 | Heating | ΔE = mcΔθ | |
| 6 | Power | P = E/t | |
| 7 | Efficiency | efficiency = E useful / E total | |
| 8 | The power station | efficiency = P useful / P total | |
| 9 | You | Ep = mgh | |
| 10 | Nothing is lost | E before = E after | |

### 1.3 每课（spread）的"叙事-场景-交互"三要素 [TXT + IMG]

- **结构**：一课 = 一个跨页（spread）。[TXT] "each lesson is one spread: the left page carries the idea, the key equation and key words"，右页图表 "lifts off the page as a working model, with glowing jars for the energy stores in play"。
- **叙事（书页文本）**：左页 = 课名 + 斜体引导 + 公式框 + 加粗导读（关键词下划线）+ 虚线活动框 + 手写体页边注 [IMG, Lesson 8 截图]。
- **场景（三维实验）**：右页整页 3D 二极管式"墨线立体图"（ink drawing），底部有 "Fig. 8." 图注条与数据来源选择行；当前选中项用手绘椭圆圈出 [IMG]。
- **交互（预测-验证循环）**：[TXT] 每课运行 "predict, watch, try, explain and a small challenge"；落地页原文："Students predict, test and prove each idea, lift the flap for the answer and earn a stamp"。挑战带数值目标（例：Lesson 2 "make the ball just reach the 0.80 m flag"；Lesson 4 "make the second bounce reach the 30 cm mark"；Lesson 7 "Make the LED give the same light as the filament lamp"）。
- **物理简化声明**：每课教学笔记列明模型简化（如 Lesson 3 "the pull stops at the limit of proportionality"——拖拽被领域规则截断）[TXT]。这与 Rondo "三维操作必须对应可验证领域状态" 同构。
- **页面组织补充** [IMG]：书口右侧有 1–10 课标签页（当前课金色缎带 #E8B820 估）；无导航箭头，交互皆为场景内直接操作。

---

## 2. 视觉语言拆解（要求 b）

### 2.1 配色

**官方 CSS 设计令牌（逐字，[CSS]）**，`assets/common-DQacebU9.css` `:root`：

```css
--paper:  #f6f0e3;   /* 纸张底色：暖米白 */
--card:   #fbf8f0;   /* 卡片/浅层底 */
--ink:    #1c2433;   /* 主墨色：蓝黑 */
--ink2:   #4b5466;   /* 次级墨色 */
--rule:   #cfc5b0;   /* 发丝线 */
--rule2:  #b8ad97;   /* 强分隔线 */
--accent: #9a3b2a;   /* 强调色：砖红（focus 同色） */
--pen:    #273463;   /* "钢笔蓝"：链接/手写编号 */
--focus:  #9a3b2a;
--chip:   #efe7d6;   /* 徽片底色 / hover 底 */
```

另有三个**模式变体**（同一 token 体系整体切换）[CSS]：

- **投影模式** `html.projector`：`--fs:25px; --paper:#fffefa; --card:#ffffff; --ink:#000000; --ink2:#1d1d1d; --rule:#6f6a60; --rule2:#2a2a2a; --accent:#8a1f0c; --pen:#001a66; --chip:#ece6d6; --measure:60rem`（≤760px 时 19px）。教室投影高对比场景专用。
- **打印模式** `@media print`：`--fs:9pt; --paper:#fff; --card:#fff; --rule:#bbb; --rule2:#888`。
- 其他字面色 [CSS]：`.btn.primary:hover` 背景 `#2c3850`；`.swatch` 内描边 `#1c243340`（8 位带透明度 hex）；`:target` 高亮用 `color-mix(in srgb, var(--chip) 70%, transparent)`。

**三维场景用色（[IMG] 官方截图估计）**：热能橙 `#E8702A→#F5A623`（渐变，估）、电蓝 `#2F6FD0`（估）、能量罐琥珀光 `#F0A030` + `rgba(240,160,48,0.25~0.4)` 光晕（估）、金缎带 `#E8B820`（估）、手写注记蓝墨 `#3A5A8C`（估）、3D 标注用红 `#B04030` / 绿 `#3A7A50` / 灰 `#555`（估）。三维描边墨色 `#3A3A3A`（估）与 CSS 的 `--ink` 同族。
**品牌底色（[IMG] 官方分享背景图估计）**：纸色 `#F7F3EA`、墨蓝 `#2C3A5F`、琥珀 `#E4A036`——与 above token 同一语言。

### 2.2 纸张质感

- **[CSS] 无任何背景纹理/噪声/渐变贴图**：common CSS 中无 `background-image`（纹理类）、无 `filter`。纸质感完全由 ① 暖纸色底 `#f6f0e3` ② 细边框线 `1px solid var(--rule)` ③ 圆角卡片（`.glance a` `border-radius:12px`，`.swatch` 2px）④ 书法字体点缀（Caveat）构成。**纸感是"色 + 线 + 字"，不是贴图。**
- **[IMG]** 截图中纸面呈极浅纤维噪感/暖色渐变，但无法区分是 3D 场景内着色还是图片压缩产物——**不作断言**；Rondo 侧建议用 ≤3% 强度的 CSS 噪声（`repeating-conic` 或 SVG feTurbulence data-URI）可选叠加，不作为还原要求。
- fallback 提示屏使用内联 `<style>`（HTML 第 3–15 行 [W3C CSS 验证器行号证据]），含 `clip-path: polygon(0 0 …)` 形状（无逗号写法）、`-webkit-font-smoothing`。

### 2.3 线稿风格

- **[CSS] 界面线宽体系**：发丝线 `1px solid var(--rule)`（卡片、表格、条目）；控件边 `1px solid var(--rule2)`；课节上边线 `.lesson{border-top:2px solid var(--ink)}`；引注左边线 `.boards li{border-left:3px solid var(--rule2)}`；打印 `.lesson{border-top:1.5pt solid #000}`、`.printfoot{border-top:.5pt solid #bbb}`。投影模式整体加粗（`.lesson` 4px、`.btn` 2px）。
- **[IMG] 三维线稿**：钢笔墨线、随笔触轻微抖动（boiled ink 手感），描边约 2px 等效（相对物体尺度），物体浅色平涂 + 轮廓墨线；无 PBR 材质感。墨色 `#3A3A3A`（估）。

### 2.4 排版

**[CSS] 字体族令牌**：

```css
--serif: "Source Serif 4 Variable", "Source Serif 4", Georgia, serif;  /* 正文/标题 */
--hand:  "Caveat Variable", "Caveat", cursive;                          /* 手写体 */
```

- common CSS **无 @font-face**（字体在别处加载，[未证] 具体来源；两族均为 Google Fonts 常见字体，Source Serif 4 / Caveat）。
- **[CSS] 字号体系**：基准 `--fs:17px`（投影 25px、打印 9pt、≤760px 16px），全站用 `rem` 相对基准缩放：课号 `.lesson-head .num` `font:600 1rem/1 var(--serif)`；次级文本 `.eqline .words`、`.inbook` `.95rem`；问题列表手写编号 `.questions li::marker{font-family:var(--hand); color:var(--pen); font-size:1.25em}`；行宽 `--measure:46rem`（投影 60rem）。
- **[IMG] 应用书页内层级（估计）**：课名衬线大标 34–42px；正文 15–17px；公式衬线斜体约 20px、其下方红色小注 10–11px（题注级）；3D 场景标注无衬线 12–14px（DOM 覆盖层卡片）；手写注记 14–16px。
- **中英文差异注记（对 Rondo 的提示）**：EJ 为纯拉丁排版，衬线正文 + 手写体点缀。中文无 Source Serif 4/Caveat 直接对应；映射建议见 §5.2。

### 2.5 光影与强调色用法

- **[CSS]** 强调色只承担语义角色：`--accent` 砖红 = 焦点/关键标注（`:focus` 同色）；`--pen` 深蓝 = 链接与手写编号；无装饰性彩色。
- **[IMG]** 三维内"光"即语义：能量流 = 发光色在 store 之间流动（[TXT] "energy flows as glowing colour between the stores"）；能量罐半透明琥珀材质 + 自发光 + 辉光（bloom 感），亮度/填充量随能量变化。光影服务于"看不见的能量可视化"，不是氛围装饰。

---

## 3. 交互模式拆解（要求 c）

以下为**有文本/截图证据**的交互模式；镜头/形变的运行时参数见 [未证] 声明。

1. **预测-验证循环（叙事内嵌问题与反馈）** [TXT]：predict（先猜）→ watch（看演示）→ try（亲手操作）→ explain（解释）→ challenge（数值目标小挑战）。答案例："lift the flap for the answer"（翻盖揭示）+ "earn a stamp"（集章奖励）。**反馈闭环 = 书的物理隐喻（翻页/翻盖/盖章），不是弹窗。**
2. **拖拽受领域规则约束** [TXT]：Lesson 3 弹簧拉伸 "the pull stops at the limit of proportionality"（到比例极限即停，公式失效边界被交互本身可视化）；Lesson 5 拖保温层使房屋散热达标；Lesson 8 点选换能源来源（8 个来源按钮即时切换全链效率）[IMG]。
3. **数值目标挑战** [TXT]：0.80 m 旗、30 cm 标线、铃铛弧顶、流明相等——目标以场景内实物（旗/标尺/铃）呈现，达成与否可直读。
4. **课间导航** [TXT+IMG]：书口 1–10 课标签页直跳；深链 `index.html#spread-N`；**无上一页/下一页箭头**——翻页由叙事顺序与课签承担。
5. **标注跟随几何体** [IMG]：3D 场景中的标注为**引线 + 白底圆角小卡**（crisp 无衬线文字 → DOM 覆盖层特征，见 §4.3）；罐体实时数字；图注条 "Fig. 8." 固定于三维页底部；来源选择行是页面 DOM 元素而非场景内文字。
6. **镜头推进 / 侧视 / 剖面 / 连续形变**：**[未证]**。[TXT] 只有 "each diagram lifts off the page as a 3D ink drawing"（图从纸面升起）与 "glowing colour between the stores"（能量流动画）。无法取证相机动画绑定方式（无 JS 源码、无可用归档渲染）。**Rondo 侧不应假设 EJ 有滚动驱动镜头；所有镜头/形变时长与缓动应按 Rondo 自行设计（§5.4 给出建议默认值）。**
7. **可访问性与模式切换** [CSS]：`prefers-reduced-motion` 门控 smooth scroll；skip-link（z-index:20，focus 时滑入）；教师页 ToC `position:sticky; top:76px`，`aria-current` 高亮；`scroll-padding-top:76px`；打印样式完整（A4、分课分页）；投影模式一键放大对比度。

---

## 4. 技术实现线索（要求 d）

1. **构建**：`assets/common-DQacebU9.css` 的哈希文件名是 Vite 类构建产物 [INF]；存在 `assets/` 目录与共享 chunk（"common-" 前缀）。JS bundle（应为 `assets/index-<hash>.js` 类命名）**未能定位**（见 §7）。
2. **HTML 与 canvas 层叠**：[INF+IMG] 3D 标注卡文字为清晰无衬线像素渲染、白底圆角带引线，且 2D 图注条/来源选择行横贯三维页底部——判定为 **DOM 覆盖层叠在 canvas 之上**（canvas 承载墨线几何与发光材质，DOM 承载文字标注与控件）。标题屏 fallback 亦证明 DOM 层独立于 WebGL 存在。
3. **WebGL 门控与降级**：[TXT+HTML] 应用首屏做能力检测，失败时整页替换为 "This book needs WebGL" 提示（保留 teachers.html 文本通路）；落地页另有轻量探测警告。**文本层（教师页/来源页）完全不依赖 WebGL，由 JS 渲染 DOM。**
4. **three.js?** **[未证]**。无任何源码或文本证据指明渲染库（可能是 three.js 也可能是自研 WebGL）。og 截图特征（自发光 + 辉光感 + preserveDrawingBuffer 类画质）不构成库判定。Rondo 不需要此判定——见 §5.5。
5. **CSS 架构（可直接借鉴）** [CSS]：单文件设计令牌 + 三模式（默认/`html.projector`/`@media print`）整体换肤；全站 `rem` 基于 `--fs`；无动画声明（common CSS 无 transition/keyframes——**文本页零动效，动效全部在 WebGL 层**）；布局断点 1060px / 760px；`.bar` sticky 顶栏 z-10；表格在窄屏 `.stack` 转块级。
6. **hash 路由** [TXT]：`#spread-N` 锚点直达课页（应用内导航与外链深链统一）。
7. **内容管线** [TXT]：63 来源/145 值、每值附原文引句与读取日期（"Every page was read on 21 October 2026"）、衍生值附计算过程——**数值内容由数据文件驱动并全部可溯源**。

---

## 5. 对 Rondo 的落地建议（要求 e）

### 5.1 可直接映射（现有 React 18 + three.js 0.186 架构内）

| EJ 技法 | Rondo 落地 | 具体做法 |
|---|---|---|
| 设计令牌三模式 | `src/styles/tokens.css`（新建一个文件） | 逐条采用 §2.1 token 名（值可微调为 Rondo 品牌倾向）：`--paper/--card/--ink/--ink2/--rule/--rule2/--accent/--pen/--chip/--fs/--measure`；同文件加 `html.projector` 与 `@media print` 变体。**收益：一套 token 覆盖课堂投影/打印/常规三场景。** |
| spread 跨页布局 | 主界面布局组件（如 `BookSpread`） | 左页约 45–48% 文本栏（课名、斜体引导、公式框、加粗导读+下划线关键词、虚线活动框）；右页 canvas 全出血；底部 `Fig.` 图注条。参考值：左页内边距 24–32px，公式框 1px `--rule` 边 + `--card` 底 + 12px 圆角。 |
| 课签导航 + hash 深链 | `LessonTabs` + `#/spread/N` 路由 | 书口（或顶部）1–N 课签，当前课金缎带式高亮（Rondo 可换自己的强调色）；无 prev/next 箭头。 |
| 翻盖/集章反馈 | 与 Rondo 服务端判分对接 | "翻盖看答案"仅在服务端判定提交后解锁（保持"答案由服务端掌握"）；章为客户端成就展示，不参与判分。 |
| 数值目标挑战 | L2 展开课的挑战任务 | 场景内实物目标（如"让展开矩形面积恰等于侧面积读数"），达成由服务端领域状态判定。 |
| WebGL 门控降级 | 入口能力检测 | 失败 → 文本学习页（题目/公式/解释 DOM 版）仍可用，与 Rondo 规则"WebGL 失败降级"一致。 |
| DOM 覆盖层标注 | three.js canvas 之上叠 DOM 标注层 | 每帧用 `vector.project(camera)` 更新标注卡位置（引线用 CSS 或 SVG）；文字全 DOM（清晰、可选中、可 i18n），场景内只留几何与发光。 |
| prefers-reduced-motion / skip-link / sticky ToC | 直接照抄 CSS 模式 | `@media(prefers-reduced-motion:no-preference)` 才开动效；skip-link z-20 模式；教师/家长页 sticky 目录 + `aria-current`。 |
| 来源文化 | 学习事实溯源页 | Rondo 服务端记录"每个数学事实/判分依据的来源与版本"，对外可展示为 sources 页——与 EJ 的 63 源/145 值同构，且强化 Rondo"服务端掌握事实"的品牌。 |

### 5.2 需要新建（EJ 无对应物，Rondo 特有）

- **中文排版栈**：`--serif` → `"Source Serif 4", "Noto Serif SC", serif`（拉丁数字用前者，汉字衬线用后者）；`--hand` → `"Caveat", "LXGW WenKai", cursive` 类（中文手写体）；基准字号中文建议 17–18px 起步（汉字密更高，`--measure` 收窄至 38–42rem）。
- **圆柱连续形变镜头语法**（EJ [未证] 项，Rondo 自定义）：侧视↔剖面↔展开的镜头/形变序列，见 5.4 建议参数。
- **圆周边↔高↔展开矩形↔尺寸标注的连续对应**：EJ 的"能量罐填充量"对应物是"标注跟随形变几何"——展开动画中让 周长标注、高标注、矩形两边标注 始终吸附在对应边上（DOM 标注层 + 每帧投影更新），这是 Rondo 的核心新组件。

### 5.3 不宜照搬

- **内容与素材**：十课能量课程、GCSE 对齐、所有文案与数值——Rondo 是圆柱 L1/L2，内容零复用。
- **桌面木纹 + 薄荷垫场景** [IMG]：EJ 的"放在桌上的实体书"取景是它的品牌记忆点；Rondo 应保留"书本隐喻"但用自己的取景（如纯纸面满幅、无桌面），避免视觉同源。
- **能量罐（jars）视觉**：语义属能量守恒，不复用；Rondo 的等价物是"侧面↔矩形面积守恒"的填充/描边强调，用同位置同辉光语法但不同形状。
- **砖红强调色值**：结构照搬（一个语义强调色 + 一个"钢笔蓝"），色值按 Rondo 品牌自定，不逐值复制 `#9a3b2a/#273463`。
- **零滚动叙事**：EJ 无滚动驱动证据，Rondo 也不做 scrolljacking；课签 + 深链 + 场景内操作已足够。

### 5.4 Rondo 侧建议参数（**全部为建议默认值，非 EJ 实测**；标注清楚供实施代理使用）

- 镜头切换（推进/侧视/剖面）：duration 900–1200ms，缓动 `cubic-bezier(0.22, 1, 0.36, 1)`（ease-out-quint 近似），同屏只动一个相机参数轴。
- 圆柱展开（连续形变）：1200–1600ms，几何顶点插值 + 相机微拉远补偿，期间标注层每帧重投影，禁止标注瞬移（跟随对应边中点）。
- 翻盖（flap）：CSS `transform: rotateX` 350–450ms；`prefers-reduced-motion` 时改为直接淡入 150ms。
- 能量/面积辉光：自发光色 = 强调色，辉光强度随量值 0→1 线性，禁用全屏 bloom（保持纸面干净）。
- 墨线材质：`MeshBasicMaterial` + 背景色平涂 + `LineSegments` 墨色描边（线宽按视距恒定像素感 1.5–2.5px），或后处理描边；**不用 PBR 光照**。

### 5.5 验收口径提醒

- EJ 证据中唯一"精度可复用"的是 CSS 令牌与结构模式；一切动效参数以 Rondo 自定 + 实测调优为准（上节默认值仅为起点）。
- Rondo 现有规则（three.js 操作对应可验证领域状态、键盘等价入口、未知 renderer 拒绝执行）优先于本简报任何建议。

---

## 6. 跨作品共享语言（作者通用模式，佐证"书本+墨线"是体系而非孤例）[IMG]

- **Two Hearts**（姊妹作，六章 3D 课）：同样深墨蓝夜空底 + 暖纸卡"章节门"，墨蓝 `#22335A`（估）、琥珀 `#E8A64A`（估）、薄荷青 `#57C2A8`（估）双主题色、衬线大标 + 手写斜体扉句、金色丝带书签、"拨曲柄"直接操作交互。
- **Wind-Up Parade**：奶油纸 `#F6EFE2`（估）+ 板岩墨 `#3B4656`（估）、青瓷/珊瑚/琥珀点彩、2–3px 墨线描边、金胶带贴角、Caveat 式手写标签、暖赤陶屋顶景深。
- 结论：**"纸色底 + 墨线 + 衬线标题 + 手写注记 + 单一暖强调 + 直接操作"是作者可复用的产品语法**，Rondo 取其语法、换其皮肤。

---

## 7. 证据索引与失败记录（要求 f）

### 7.1 成功取证的来源

| 编号 | 来源 URL | 方法 | 产出 |
|---|---|---|---|
| E1 | https://iamtechartist.com/every-joule/ | WebFetch（直接 + jina 渲染） | 落地页全文引句（§1.1、§3.1）；WebGL 警告原文 |
| E2 | https://iamtechartist.com/Apps/every-joule/ | WebFetch；W3C Nu HTML 验证器 `?out=json` 的 extract 字段 | head 元信息：viewport `width=device-width, initial-scale=1, viewport-fit=cover`、meta description 起句 "A physics book about energy where every diagram lifts off the page as a 3D ink dr…"（截断）、canonical → /every-joule/；fallback 屏存在；内联 style 位于 HTML 第 3–15 行（W3C CSS 验证器行号） |
| E3 | https://iamtechartist.com/Apps/every-joule/teachers.html | WebFetch 经 r.jina.ai 渲染（JS 渲染文本） | §1.2 十课清单、§1.3 spread 结构与 predict/watch/try/explain/challenge、逐课 predict/challenge 原文、模型简化声明、`index.html#spread-1` 深链格式 |
| E4 | https://iamtechartist.com/Apps/every-joule/sources.html | WebFetch 经 r.jina.ai | 63 sources / 145 values、逐值原文引句与读取日期（§4.7） |
| E5 | **https://iamtechartist.com/Apps/every-joule/assets/common-DQacebU9.css**（经 W3C CSS 验证器发现其存在，随后直接抓取原文两遍） | WebFetch | §2.1 全部令牌、§2.3 线宽、§2.4 字体/字号、§3.7 与 §4.5 全部结构证据（`.bar/.toc/.lesson/.glance/.eqline/.questions/.inbook/.swatch/.chips/.srclist/.vals` 等类名与规则原文） |
| E6 | https://iamtechartist.com/wp-content/uploads/2026/10/every-joule-og.jpg | 只读视觉分析（官方发布的应用真实书页截图，Lesson 8） | §1.3 页面分区、§2.1 三维用色（估）、§2.3 三维线宽（估）、§2.5 光影语义、§3.5 标注卡形态、§3.4 课签 |
| E7 | https://iamtechartist.com/wp-content/uploads/2026/10/home-wide.jpg；two-hearts-og.jpg；wind-up-parade-og.jpg；share-background.jpg | 同上（视觉估计） | §2.1 品牌底色（估）、§6 跨作品语言（估） |
| E8 | https://iamtechartist.com/sitemap.xml → sitemap-1.xml、image-sitemap-1.xml | WebFetch | 站点页面清单与全部上传图片 URL（E6/E7 的来源） |
| E9 | https://iamtechartist.com/demos/、/two-hearts/、/playlist/ | WebFetch | 作品矩阵与 Two Hearts 描述原文（§6 背景） |

### 7.2 未能取证的项目与失败记录（如实）

- **JS bundle 与运行时源码**：`assets/index-*.js` 哈希名无法发现。已尝试并失败：直接 WebFetch 原始 HTML（markdown 转换剥离 `<script>`）；r.jina.ai 渲染（其无头浏览器 WebGL 失败，只回退提示屏）；Google PageSpeed Insights API 4 次尝试全部 HTTP 429（匿名配额）；allorigins JSON 代理 500/522（多次）；whateverorigin 400；Wayback CDX（全域名 0 归档）、archive.today 404、Memento TimeTravel DNS 失败、urlscan.io 0 扫描记录；Nu 验证器对两页仅回传 head 区 3–4 条 extract（页面 HTML 过于干净，无 body 内片段）；常见文件名试探（main.js/app.js）404。
- **three.js 使用与否**：[未证]（同上原因）。
- **镜头动画/滚动驱动机制**：[未证]（同上；且 common CSS 无任何 transition/keyframes，仅文本页 smooth-scroll）。
- **字体加载方式**（Google Fonts vs 自托管 woff2）：common CSS 无 @font-face，加载点在未取证的 JS/样式内 [未证]；字体族名称本身是 [CSS] 精确的。
- **三维场景内是否用后处理 bloom**：[IMG] 仅辉光观感，判定 [未证]。
- 结论：**凡 §5.4 中的动画时长/缓动均为 Rondo 建议值，不得在交付记录中记为"EJ 实测"。**

### 7.3 合规声明

本研究仅做只读抓取与官方公开图片的视觉分析；未使用浏览器自动化、未创建任何归档/扫描记录、未改动 Rondo 代码；简报不复制 EJ 的课程内容与素材，仅提炼结构与技法。
