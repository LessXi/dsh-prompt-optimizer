# Changelog

本项目版本号遵循 `0.x` 阶段的语义化：`0.<minor>.<patch>`；预发布版本带 `-beta.N` 后缀（面板中显示为 `0.1.1beta1`）。

## v0.4.0 — 极端档只读查证接入真实路径（语义收窄）

### 变更

- **极端档语义收窄为「只读查证 · 仅用于消歧与校验」**：此前 `TIER_SPECS.extreme.system` 要求模型产出「分阶段执行计划」，并自行判断「这次任务是否值得让工作 AI 用 goal / todo / 计划模式跟踪」。计划工作属于 DSH 的 plan 模式，不该由提示词优化器代劳，这两项已从 system prompt 中移除；保留的是**命令结构固化**（要做什么／验收标准／硬约束／不许做什么）与**多情况预案**。
  新增的边界四条：只用于消歧与校验；不得把查到的项目事实写成用户没提过的新要求、新验收项或新技术选型；与项目实际不符时写成让工作 AI 先确认的措辞；查不到就如实留空，也不为查而查。

### 修复

- **极端档的只读工具循环此前从未在真实用户路径上运行**：`executeLiveRun()` 调用 `streamWithTools()` 时第 5 个参数（`tools`）恒为字面量 `undefined`，而带工具循环的 `runToolLoop()` 只被自检专用的 `runVersion()` 调用。因此用户在界面上选「极端」后插件并不会读取项目，`.dpo-trace` 面板也永远显示「（暂无查证动作）」。现在 `executeLiveRun()` 在 `run.tier === 'extreme'` 时改走 `runToolLoop()`，以 `resolveSessionCwd(ctx)` 得到的工作区作为项目根，并把 `relayMessage()` 的产物直接作为消息数组传入。
- **`opts.userText` 被重复包装**：`relayMessage()` 返回的本就是 `userMessageFor(...)` 的结果（消息数组），`runToolLoop()` 又对其调用一次 `userMessageFor()`，使指令正文被序列化成 `[object Object]` 送给模型（产物首句表现为「本次指令正文未收到有效内容（收到的是占位符 `[object Object]`）」）。现改为 `Array.isArray(opts.userText) ? opts.userText : userMessageFor(opts.userText)`，同时兼容自检路径的纯文本入参。

### 改进

- **查证过程实时可见**：`runToolLoop()` 新增 `onDelta` / `onReset` / `onTrace` 三个回调，经 `publishRun()` 推给前端 —— `onDelta` 透传流式增量，`onReset` 在多轮查证之间清空产出（否则各轮文本会拼接成最终结果），`onTrace` 每次工具调用后推送完整查证记录。前端 `es.onmessage` 新增 `text-reset` 与 `trace` 两个分支，`traceRows()` 改为优先读取 `store.run.trace`，探针通道的 `store.trace` 仅作兜底。
- 档位文案同步：`hint` 由「反复查证，约 20 秒以上」改为「读项目消歧，约 20 秒以上」，`help` 由「读项目真实结构 → 分阶段行动计划 + 预案（约 20 秒）」改为「读项目真实情况，仅用于确认指代（约 20 秒）」；帮助面板推荐语同步更新。
## v0.3.1 — 优化前后同屏对照 + 档位显示中文

### 修复

- **`.dpo-run-status` 的档位显示英文 id**：运行状态行（「档位 advanced · 已完成 · 首字 591ms」）用的是 `run.tier` 原始 id，而非 `TIERS` 的 label —— 同一屏的 `.dpo-overlay-src` 却已显示中文「发送：审查」，两者并列时明显割裂。同源问题还存在于优化完成通知：`showNotice("已按 " + run.tier + " 档优化结果发送")`。两处均改为 `((TIERS.find((x) => x.id === run.tier) || {}).label || run.tier)`，与 `.dpo-overlay-src` 的处理方式一致。

### 改进

- **「你的原文」提到结果之后，优化前后可同屏对照**：此前 `.dpo-orig{order:5}` 排在滚动区末位，而优化完成后用户的第一个动作往往就是「对照原文，确认有没有改坏、有没有丢关键信息」。真实 done 态量测：原文 `top 444`、textarea `bottom 204` → 相距 **240px**，`origVisibleNow = false`；必须滚动才能看到原文，而滚到原文时 textarea 已离开屏幕，无法对照。
  调整顺序为 `元信息(1) → 结果(2) → 原文(3) → 思考(4) → 查证(5)` 后：原文 `top 220`、相距 **16px**、`origVisibleNow = true`，且原文完整落在首屏内（`orig.bottom 298 < clientH 393`）。

### 实现要点

- 只调整 CSS `order`，不动 DOM 结构（`.dpo-orig` 仍是 `.dpo-overlay-scroll` 的直接子级），因此不影响 `runPanes()` / `reviewPane()` 的任何渲染逻辑，也不触碰 `.dpo-review` 内部那三处 order 依赖。
- 保留 `.dpo-run`（思考）与 `.dpo-trace`（查证）的相对次序：它们属于过程信息，排在结果与原文之后。

## v0.3.0 — 优化结果一键复制

### 新增

- **一键复制优化结果**：浮窗「检查后提交」标题行右侧新增「复制」按钮。优化结果通常数百字、且可能已被手工编辑，此前只能手动全选 —— 插件此前完全没有 clipboard 支持。

### 实现要点

- `copyResult(btn)`：优先 `navigator.clipboard.writeText`；被拒或不可用时回退 `document.execCommand("copy")`，回退前保存并恢复 textarea 的原选区。
- 反馈：成功后按钮变「已复制」+ `data-copied="1"`（品牌色 12% 底 + 品牌色字），1.4s 后自动还原；失败显示「复制失败」。
- 按钮置于 `.dpo-pane-title` 内部、`margin-left:auto` 顶到行尾。**没有包一层 wrapper**：`.dpo-review` 的直接子级被 order 规则依赖（`.dpo-review > .dpo-pane-title{order:2}`），加 wrapper 会一并破坏 `.dpo-regen-ask` / `.dpo-review-text` 的排序。
- 样式遵循 DSH 控件语言（默认无边框无底色、hover 才浮出浅灰底）：`border:0`，起始色 `label-tertiary`，hover 用 `interactive-bg-hover`，成功态用 `state-business-primary` —— 全部为 DSH 语义 token，无硬编码色值。

### 验证

- 参数正确性（mock clipboard）：`capturedEqualsTextarea = true`
- 真实 clipboard 路径：不抛异常、按钮进入「已复制」态
- 1400ms 后自动还原
- clipboard 被拒时确实走回退分支（`execCommand` 被执行）
- computed style：`borderTop 0px`、`color rgb(129,133,140)`、`padding 4px 10px`、`margin-left:auto` 解析为 179.125px、按钮右缘与标题行右缘间距 0px

## v0.2.0 — fork（基于上游 v0.1.1-beta.1）

> 🔀 本仓库是 [`LessXi/dsh-prompt-optimizer`](https://github.com/LessXi/dsh-prompt-optimizer)，上游为 [`WestFox-AwA/dsh-prompt-optimizer`](https://github.com/WestFox-AwA/dsh-prompt-optimizer) 的 `v0.1.1-beta.1`。包名改为 `@lessxi/dsh-prompt-optimizer`，可与上游并行安装。**上游的功能与设计意图全部保留**，以下均为增量。

### 修复的上游缺陷

- **档位 / 发送下拉按钮点了打不开**：`onClick` 里 `store.tierPopOpen = !store.tierPopOpen` 之后，紧跟的四路互斥块又写了 `store.tierPopOpen = false`（把自己也置回），弹层永远无法打开。`Shift` 之类的操作无法规避，实际是「按钮完全无响应」。
- **窄屏「档位」按钮弹出的是模型列表**：`data-dpo="tier-collapsed"` 的 `onClick` 写的是 `store.modelPopOpen`，语义错位。
- **`--dsw-alias-bg-l1` 在 DSH 中不存在**：插件引用了 8 个 `--dsw-*` token，只有这一个在 `@deepseek-ai/dsh-client-ui-theme` 里查无此名，而被用在 4 处；回退值是暗色 `#141414`，浅色主题下渲染成**黑色编辑框**。改用真实存在的 `--dsw-alias-bg-layer-1`。
- **弹层互斥不完整、且没有「点击外部 / Esc 关闭」**：四个弹层各写各的互斥（模型按钮零互斥），点两个不同按钮会**同时悬空两个弹层**；打开后只能点各自的「关闭」。新增 `closePops(one)` 单一互斥入口 + 全局 `pointerdown`/`keydown` capture 监听（判定时排除弹层自身与四个触发按钮，否则会出现「点不掉」）。
- **`.dpo-overlay-scroll` 的子项会被压成 1px**：flex column 容器的直接子项默认 `flex-shrink:1`，而 `.dpo-trace` 的 `overflow:auto` 让 `min-height:auto` 解析为 0 —— 内容溢出时整块查证动作只剩一条边框（实测 8 行、`offsetHeight:1`、0 行可见）。补 `flex:0 0 auto`。
- **矮视口下查证动作只有 1 行可见**：`@media (max-height:640px)` 里的 `max-height:72px` 是照早期 padding（表头 24px + 行 19px）估的，padding 被放大到 29px/23px 后没同步，8 行里只有 1 行完整可见。改为 `min(150px,26vh)` 并给表头 `position:sticky`。
- **error 态同一屏两组重复出口**：错误行自带「重试 / 恢复默认模型并重试」，底部常驻操作栏也有「重试 / 默认模型重试 / 按原文发出」，`onClick` 逐字节相同；且 `.dpo-run-error` 的 `word-break:break-all` 会**继承给子按钮**，中文被压成竖排（一个字一行）。
- **模型弹层的标题行缺失**：删除窄屏专用 `.dpo-pop-sliders` 时把同一可见块里的 `.dpo-pop-head` 一并删掉了。
- **done 态出现没有标题的孤立原文片段**：`setOverlay` 是 `Object.assign` 合并语义、不清除未提及字段，run 态写入的「原文前 80 字」在 review 态残留。

### 视觉与交互（与 DSH 本身对齐）

- 控件行胶囊**逐属性**对齐 DSH composer：高度 30→**28px**、圆角 8→**24px**、字号 12→**13px**、字重 400→**500**、padding `0 4px 0 8px`、去边框。
- 下拉箭头 **1:1 复刻** DSH 官方 chevron（CSS `mask-image`，624 字符 path，颜色继续跟随主题而非写死）。
- 档位 / 发送由横向滑块改为**下拉**：4 档与 2 档都是离散取值，滑块是「连续量」隐喻；DSH 原生对同类选择一律用下拉。
- 弹层配色对齐 DSH 原生菜单：**纯白底**（不用毛玻璃）、圆角 **20px**、条目圆角 10px。
- 帮助弹层**去蓝**：行标题原为品牌蓝 + 600 字重（一屏 13 行里 9 行是蓝的），改为 `label-primary` + 500，符合 DSH「行标题 primary / 说明 secondary / 分组标题 caption」的灰阶层级 —— 彩色只给主操作。
- 浮窗：标题栏三列 grid（修复回退按钮被甩到最右列）、查证动作表头 sticky + 底部渐隐、长内容 `.dpo-pane` 用 `mask-image` 做 26px 渐隐（`.dpo-pane` 是 `overflow:auto`，绝对定位伪元素会随内容滚动，mask 不会）、原文摘要 `min(50vh,360px)`。

### 功能

- **「你的原文」**：done 态补回原文摘要并加标题 —— 「优化前后可对比」正是提示词优化器的核心价值。
- **文案收敛到单一数据源**：`TIERS` / `PERMISSIONS` 各补 `hint`（弹层短说明）与 `help`（帮助长说明）字段，弹层与帮助面板共用。原先三处各写一套，且帮助面板用的是「需要审查 / 自动输出」等与界面标签对不上的旧文案。
- **键盘可达**：弹层内 `ArrowDown`/`ArrowUp`/`Home`/`End` 环绕导航，打开时把初始焦点交给当前选中项。
- **无障碍**：下拉按钮补 `aria-haspopup`/`aria-expanded`，浮窗补 `role="dialog"` 与 `aria-label`，运行状态行补 `aria-live="polite"`。

### 宿主端（lib/index.js）

- `loadPluginState` 对 `tier`/`permission` 补**白名单校验**：原先只判 `typeof === 'string'`，而同一文件的 `sanitizePerSession` 却严格用 `TIER_IDS.has()`；非法值经 `GET /state` 进入客户端后控件行渲染成空字符串，且会被 POST 写回持久化。
- `savePluginState` 改**原子写**（写 `.tmp` → `renameSync`），失败时把 `saveError` 带进状态对象，不再静默。
- `readJson` 的损坏留痕经 `GET /state` 的 `readError` 字段暴露；读盘成功时清除留痕（否则修好的文件会一直报警，比不报警更糟）。原先 `catch { return fallback }` 静默吞掉，配合客户端 `.catch(() => {})` 形成**端到端静默失败**。
- `mirrorToSettings` 的 `settingsStatus` 不再随保存次数无限追加 `" (mirror-skipped)"`。
- `liveRuns` 补保留上限与 `pruneLiveRuns` 回收，终止态打 `endedAt` 时间戳（原先长会话内存单调增长）。

### 与上游的差异范围

```
lib/client.js    | 763 ++++++++++++++++++++++++++++++++++------  （主题层 / 交互层 / 浮窗层 / 文案与可达性）
lib/index.js     |  58 +++-                                    （状态层健壮性）
package.json     |   4 +-                                     （name / version）
cordis.patch.yml |   2 +-                                     （bundle entry name）
```

上游保留的文件：`ACCEPTANCE.md`、`DELIVERY.md`、`evidence/`（均为 v0.1.1-beta.1 的验收与自检留痕，未作改动）。

## v0.1.1-beta.1 — 2026/09/11

作者：啃轮胎的西狐

首个对外分享版本。核心能力：

- **发送接管**：捕获阶段拦截回车与发送按钮（`Shift+Enter`、`/` 命令、空草稿、卡片外回车一律放行）。
- **传话者语义**：优化 AI 明确是"把用户意思转达给工作 AI"的传话器 —— 不回答用户、不替用户干活、不向用户提问；产出是**可直接发送的命令正文**，无「优化后的提示词 / 改动说明」这类元话语。
- **三档强度**：普通（语言精确化，约 3 秒）／高级（补"显然需要"的约束与验收，约 20 秒）／极端（只读查证项目结构 → 分阶段行动计划 + 验收标准 + 多情况预案，约 20 秒）。
- **两种权限**：需要审查（产出可编辑，确认后发送）／自动输出（完成即发送；失败也按原文发出，绝不静默吞消息）。
- **迷你窗**：可拖动、可改尺寸（记忆）、按会话隔离、常驻底部操作栏（窗口再小按钮也不消失）、思考/产出双通道流式 + 流式光标 + 自动跟随滚动、**思考 token 计数**。
- **按会话独立的档位与权限**：A 会话的设置不影响 B。
- **模型独立**：优化模型与对话模型互不影响；目录预热 + 双层缓存 + 单家超时，死模型自动回退。
- **使用帮助**：控件行 `?` 面板（怎么用 / 档位 / 权限 / 迷你窗按钮 + 推荐组合）。
- 测试与证据：`ACCEPTANCE.md` 逐格验收清单；`evidence/` 内为自检报告、三档对照、几何与产物形态回归等机器留痕。

### 已修复的典型缺陷（详见 `ACCEPTANCE.md`）

- 回退 / × 点击无效（pointerdown 的 `preventDefault` 抑制了 click）。
- 审查态看不到确认提交 / 重新生成（浮层内容被裁且不可滚动）。
- 浏览器缩小后弹窗出现在不可见坐标（开窗未夹紧）。
- 开启档位后"无法发送"（优化模型不可用 + 失败被静默吞掉）。
- 弹窗不再显示（React #310：hook 写在 early return 之后）。
- 模型目录加载不出来（客户端从未拉取 `/models`）。
- 右下角拖不动改尺寸（手柄被常驻底栏盖住 + `onSizeUp` 丢掉最后一次位移）。
- 优化 AI 误以为在跟用户对话（角色与用户消息都缺少"传话"框架）。
