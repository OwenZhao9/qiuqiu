# 交互规范

`frontend` 分支的输入。IPC 方法名取自 `docs/CONTRACTS.md` § 2，路由取自 § 1。契约版本 **v0.1.2**。

受 **AD-5** 约束：桌面端只有主窗口持有 SSE 与 WebSocket。桌宠窗口的流式数据全部经主进程 IPC 转发，桌宠的输入经 `submitFromPet` 交主窗口发出。桌宠窗口**不直接发任何 HTTP 请求**。

受 **AD-1** 约束：状态机在前端本地跑，桌宠的表情来自 `setPetState`。

## 1 · 桌宠窗口

Electron `BrowserWindow`：`transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, hasShadow: false`。页面背景全透明，只有丘丘的舞台容器与（展开后的）输入条两个可见元素。

**窗口比丘丘大一圈**：四周各留 `PET_BLEED`（28 px）的透明余量。落地投影画在丘丘轮廓**外面**，模糊半径 14（σ=7）可见范围约 3σ = 21 px、加 6 px 下偏移；窗口正好卡在丘丘边上的话，`overflow: hidden` 会把投影裁成四条直线，看着是丘丘外面套了个方框。反过来把投影删掉，丘丘又变成贴在屏幕上的一张贴纸。所以是**留地方，不是删投影**。这块余量全透明、鼠标穿透，只影响窗口多大，不影响丘丘看着多大。

「不像贴纸」靠三层叠出来，投影只是其中一层：

| 层 | 做法 | 解决哪一半 |
|---|---|---|
| 悬浮微动 | `qq-pet-float`，4.5 s 一个来回、上下 4 px，挂在 `.qq-pet__anchor` | 不动 —— 贴纸的定义就是不动 |
| 拖动滞后与回弹 | `lean.ts` 的弹簧，姿态写成 `--qq-lean-x/y/r` 传给 `.qq-pet__ball`，绕 `50% 82%` 转 | 是个物体，不是刚体贴图 |
| 高光跟光标 | `instance.setLight(nx, ny)` 挪球体渐变的光心（与注视共用一组坐标） | 光跟环境无关 |

三层都在 `prefers-reduced-motion` 下关掉。倾斜上限 10 px 与 `PET_BLEED` 是一组数：倾出去超过余量，投影又会被窗口裁到。

### 窗口几何

| 状态 | 窗口尺寸 | 内容布局 |
|---|---|---|
| 收起 | 256 × 256 | 丘丘 `--qq-ball-size-pet`（200 px）居中，四周各 28 px 投影与倾斜余量 |
| 展开 | 336 × 304 | 丘丘 200 × 200 在上，下方 `--qq-pet-gap`（8 px）间隙，再下是 320 × 40 的输入条；四周仍是 28 px 余量 |
| 有气泡 | 宽同上，高 + 气泡高 + 8 | 气泡排在丘丘**上面**，窗口往上撑。气泡不能用 `position: absolute` 钉在窗口外——会被裁掉 |

宽度 336 = 320 + 2 × 8 的左右留白。尺寸变化时**球心必须不动**：

- 收起 → 展开：窗口宽 +80、高 +48，同时 `window.x -= 40`，`window.y` 不变
- 气泡出现：高 + 气泡块，`window.y` 减掉同样多
- 球心 = `(x + width / 2, y + PET_BLEED + 气泡块 + 100)`，**不是窗口中心**

球心跳一下是桌宠最招人烦的毛病，这条不能商量。窗口尺寸变化用主进程的 `setBounds`，不加动画（Electron 的窗口动画在两个平台表现不一致）；输入条自身用 `--qq-duration-fast` + `--qq-ease-out` 做 `opacity` 与 `translateY(-4px → 0)` 的进场。

### 鼠标穿透

默认 `win.setIgnoreMouseEvents(true, { forwardMouseMove: true })`——桌宠不挡住底下的窗口，但仍然收得到 `mousemove` 用来驱动 `ball.setGaze(nx, ny)` 注视。

渲染进程用 `elementFromPoint` 判断指针是否落在丘丘的实心轮廓或输入条上，落上了就 IPC 请主进程 `setIgnoreMouseEvents(false)`，移开再设回 `true`。判定用 rAF 节流，一帧最多一次。

`setGaze` 的归一化坐标：以窗口中心为原点，指针位置除以「屏幕对角线的一半」，再钳到 `[-1, 1]`。全屏范围内都跟，不只是窗口内。

### 指针手势

`pointerdown` 落在丘丘上时开始判定，三个阈值：

| 判定 | 条件 | 动作 |
|---|---|---|
| **单击** | `pointerup` 距 `pointerdown` ≤ 400 ms，且期间位移 ≤ 4 px | 切换输入条展开 / 收起 |
| **拖动** | 位移首次超过 4 px（不等 `pointerup`） | 进入拖动，取消单击判定 |
| **右键** | `contextmenu` 事件 | 弹菜单，见下 |

拖动：每个 `pointermove` 调 `window.qiuqiu.dragPet(dx, dy)`，`dx/dy` 是相对**上一次** move 的增量（不是相对起点），单位 CSS 像素。主进程累加到窗口位置。

- 拖动期间输入条若已展开，保持展开，跟着一起动
- 拖动期间 `setGaze` 暂停，丘丘目视前方
- 松手时把窗口位置写进 `settings`，下次启动恢复
- 窗口边缘吸附：松手时若窗口任一边距屏幕工作区边缘 ≤ 16 px，贴齐该边
- 窗口不允许被拖出工作区：至少 48 px 留在屏幕内，超出时钳回

### 右键菜单

用 Electron 原生 `Menu.popup`，不是 HTML 菜单——HTML 菜单在透明窗口里会被窗口边界裁掉。

| 菜单项 | 调用 | 备注 |
|---|---|---|
| 打开主窗口 | `openMain()` | 默认项，加粗 |
| 收起丘丘 | `hidePet()` | 收起后从托盘图标恢复 |
| 回到默认位置 | `resetPet()` | 右下角，距工作区右边与下边各 24 px |
| — | 分隔线 | |
| 暂停被动采集 | 前端本地开关 | 勾选态。停止麦克风与摄像头切片，不再 `POST /ingest` |
| — | 分隔线 | |
| 退出丘丘 | `quit()` | |

### 键盘

桌宠窗口只在输入条聚焦时才拿得到键盘焦点。

| 键 | 条件 | 动作 |
|---|---|---|
| `Esc` | 输入条展开 | 收起输入条；已输入的文本**保留**，下次展开还在 |
| `Esc` | 输入条已收起 | 不做任何事。刻意的：不让 `Esc` 隐藏桌宠，否则误触之后用户找不回来 |

全局快捷键（主进程注册，两个平台各一套）：`Cmd/Ctrl + Shift + K` 唤起桌宠并展开输入条，等价于 `focusPet()` + 展开。**不能用 `Cmd/Ctrl+Shift+Q`**：macOS 上那是系统的「退出登录」，Electron 抢不到时会静默失效，而用户按下去是真的退出登录。

### 回复的呈现

桌宠不显示完整对话，只显示当前这一轮：

- 收到 `onDelta` 时，在丘丘上方浮出气泡，最大宽度 320 px、最多 6 行、超出部分滚动到底
- 气泡背景 `--qq-color-surface`、`--qq-radius-lg`、`--qq-shadow-3`、内边距 `--qq-space-5`
- 收到 `onDone` 后气泡停留 6 s，然后 `--qq-duration-slow` 淡出。期间鼠标悬停在气泡上则不淡出
- 气泡出现时窗口高度临时增加，球心仍然不动（向上扩）
- 想看全文点气泡，等于 `openMain()`

## 2 · 输入条

桌宠窗口的内联输入条与主窗口底部的输入区**行为完全一致**，只有尺寸不同。差异只有一条：桌宠的提交走 `submitFromPet(text)`，主窗口的提交直接 `POST /chat`。

| | 桌宠 | 主窗口 |
|---|---|---|
| 宽度 | `--qq-pet-input-w`（320 px） | 中栏宽度减去 `--qq-space-6` × 2 |
| 高度 | `--qq-pet-input-h`（40 px）固定，单行 | `--qq-composer-min-h`（52 px）起，随内容长到 `--qq-composer-max-h`（200 px），再长内部滚动 |
| 附件 | 不支持拖入，粘贴图片时提示「请在主窗口发送图片」 | 支持 |
| 语音按钮 | 有 | 有 |

### 键盘

| 键 | 动作 |
|---|---|
| `Enter` | 发送。内容去首尾空白后为空则不发，不报错 |
| `Shift + Enter` | 换行。桌宠的单行输入条上等同于无操作 |
| `Cmd/Ctrl + Enter` | 同 `Enter`，给习惯这个组合的人 |
| `Esc` | 桌宠：收起输入条。主窗口：若正在流式输出则中止本轮（等价于点「停止」），否则清空输入框 |
| `↑` | 输入框为空时，载入上一条自己发过的消息，可连按往前翻 |

**输入法组字期间 `Enter` 绝不发送。** 监听 `compositionstart` / `compositionend` 维护一个 `isComposing` 标志，`keydown` 里同时检查 `event.isComposing` 与该标志——中文用户按下的每一次 `Enter` 有一半是在选词。这条是中文界面的头号 bug 来源。

### 语音按钮

按住说话，不是点击切换。

| 阶段 | 触发 | 动作 |
|---|---|---|
| 按下 | `pointerdown` | `POST /voice/session` → 建 `WS /voice/stream` → 状态机进 `listening`（T2）。按钮变 `--qq-color-brand` 实心，出现音量波形 |
| 按住不足 300 ms 就松开 | `pointerup` | 视为误触：断开连接，回 `idle`，输入条位置提示「按住说话」，1.5 s 后消失。不发 `POST /chat` |
| 说话中 | WS `partial` 帧 | 转写文字实时填进输入框，`--qq-color-text-muted`，用户可见但不可编辑 |
| 上滑取消 | 指针相对按下点上移 > 60 px | 按钮变 `--qq-color-danger`，提示「松开取消」；此时松手直接断开，转写作废，回 `idle` |
| 松开 | `pointerup` | 停止上行音频，等 `final(role=user)` 帧；转写非空则填进输入框并自动发送（T3），空则回 `idle`（T4） |
| 出错 | WS `error` 帧 | 断开，回 `idle`，按 `docs/CONVENTIONS.md` 显示带 `hint` 的错误行 |

`mode` 由 `POST /voice/session` 的响应决定（`cascade` 或 `realtime`），前端只据此决定拿到 `final` 后是否要自己 `POST /chat`（`cascade` 要，`realtime` 不要），界面表现两种模式完全一样。

无麦克风权限时按钮置灰，点击弹权限说明。

### 拖入图片（仅主窗口）

| 事件 | 行为 |
|---|---|
| `dragenter` / `dragover` 且 `dataTransfer` 含文件 | 中栏整体浮出虚线投放区：`--qq-border-thick` 虚线、`--qq-color-brand` 描边、`--qq-color-brand-subtle` 底、`--qq-radius-lg`，文案「松开添加图片」 |
| `dragleave` 离开中栏 | 撤销高亮 |
| `drop` | 逐个文件 `POST /blobs`（multipart），拿到 `blob_id` 后在输入框上方生成一个 64 × 64 的缩略图卡片 |
| 粘贴（`paste` 事件里有 `image/*`） | 与 `drop` 同一条路径 |

限制，超出的文件**逐个**给出带 `hint` 的提示，不整批失败：

- 格式：`image/png` `image/jpeg` `image/webp` `image/gif`
- 单张 ≤ 10 MB
- 一条消息最多 4 张
- 非图片文件一律拒绝，提示「目前只支持图片」

缩略图卡片右上角有删除按钮；上传中显示进度环，失败显示重试按钮。发送时按 `docs/CONTRACTS.md` § 1 拼成 `attachments: [{ type: "image", blob_id }]`。

## 3 · 主窗口三栏与响应式

Electron 主窗口最小尺寸 640 × 480，默认 1200 × 800。

### 三栏

| 栏 | 宽度 | 内容 |
|---|---|---|
| 左 | `--qq-sidebar-left`（260 px），固定 | 顶部丘丘 `--qq-ball-size-main`（120 px）+ 状态文字；会话列表；底部设置、人格、记忆库入口 |
| 中 | `flex: 1`，最小 `--qq-main-min`（480 px） | 顶部会话标题栏 `--qq-header-h`；消息流；底部输入区 |
| 右 | `--qq-sidebar-right`（340 px），固定 | 记忆事件侧栏，见 `design/memory-panel.md` |

左右两栏与中栏之间各一条 `--qq-border-thin` 的 `--qq-color-border` 分隔线。整体底色 `--qq-color-bg`，中栏消息区 `--qq-color-bg-subtle`。

### 断点

以**窗口宽度**为准，不是屏幕宽度。媒体查询里写死数字，`--qq-bp-*` 令牌只给 `matchMedia` 用。

| 断点 | 左栏 | 中栏 | 右栏 |
|---|---|---|---|
| ≥ 1280 px | 260 px 展开 | flex | 340 px 常驻 |
| 1024 – 1279 px | `--qq-sidebar-left-collapsed`（56 px）图标条，悬停浮出全宽 | flex | 340 px 常驻 |
| 720 – 1023 px | 56 px 图标条 | flex | **抽屉**：从右滑入，340 px，覆盖中栏，带 `--qq-color-overlay` 遮罩，`z-index: var(--qq-z-overlay)` |
| < 720 px | **抽屉**：从左滑入，260 px，带遮罩 | 独占 | 抽屉，同上 |

抽屉滑入滑出：`--qq-duration-base` + `--qq-ease-standard`，遮罩同步 `opacity`。点遮罩、按 `Esc`、或窗口宽度回到该断点以上时关闭。两个抽屉不能同时打开，后开的关掉先开的。

`< 720 px` 时丘丘只在左抽屉里渲染，中栏标题栏用一行文字表示状态（「在听」「在想」「在说」「待机」）。刻意不在窗口宽度不足时另起一个丘丘尺寸——三个尺寸已经够多了。

窗口宽度低于 640 px 由 Electron 的 `minWidth` 兜住，网页端则一路收到 320 px：低于 720 px 的规则继续生效，只是中栏更窄，输入区的语音按钮与附件按钮合并进一个「+」菜单。

## 4 · 网页端与桌面端的差异清单

同一套 React 代码，差异集中在一个 `platform` 适配层里，组件不做平台判断。

| 能力 | 桌面端（Electron） | 网页端 | 网页端怎么退化 |
|---|---|---|---|
| 桌宠窗口 | 有，透明置顶常驻 | **无** | 丘丘 `--qq-ball-size-web`（160 px）内嵌在页面左栏顶部，随页面滚动 |
| IPC 桥 `window.qiuqiu` | 有，见 `docs/CONTRACTS.md` § 2 | **无** | 适配层提供同签名的实现：`setPetState` / `forwardDelta` / `forwardDone` 走前端内存事件总线；`openMain` / `hideMain` / `hidePet` / `dragPet` / `resetPet` / `focusPet` / `quit` 全部 no-op |
| SSE 持有者 | 只有主窗口（AD-5） | 页面本身 | 同一份状态机代码，事件源从 IPC 换成内存总线 |
| 全局快捷键 | `Cmd/Ctrl + Shift + K` | **无** | 浏览器拿不到全局热键，不提供替代 |
| 托盘图标 | 有 | **无** | — |
| 窗口拖动与吸附 | 有 | **无** | 丘丘在页面里不可拖动 |
| 鼠标注视 `setGaze` | 全屏范围 | 页面视口范围 | 归一化基准从屏幕对角线换成视口对角线 |
| 右键菜单 | Electron 原生菜单 | 浏览器默认菜单 | 不劫持右键。菜单里的功能改由左栏底部的设置面板提供 |
| 被动采集（麦克风 / 摄像头） | 常开，进程存活即采集 | 需用户手势授权，标签页不可见时**暂停** | 页面 `visibilitychange` 转不可见时停止切片；转可见时恢复并提示「刚才暂停了采集」 |
| 语音输入 | 按住说话 | 按住说话，首次需授权 | 无差异 |
| 拖入图片 | 支持 | 支持 | 无差异 |
| 音频播放（TTS） | 直接播 | 首次需一次用户手势解锁 `AudioContext` | 未解锁时显示一次「点一下开启语音」，解锁后不再提示 |
| 闲置策略 | 开（`04` @ 90 s，`00` @ 300 s） | 开，但标签页不可见时冻结计时 | `visibilitychange` 时调 `ball.resetIdle()` |
| 主题切换 | 跟随系统 + 手动，写 `localStorage` | 同左 | 无差异 |
| 后端地址 | `window.__QIUQIU_API__`（`http://127.0.0.1:8000`） | 同源 `/api` 反代到同一后端 | 适配层统一出一个 `apiBase` |

三条对两端都成立的硬约束：

1. 状态机、情绪推断、事件侧栏的渲染逻辑**同一份代码**，不允许出现 `if (isElectron)` 分支。平台差异只在适配层与 CSS 断点里。
2. `docs/CONTRACTS.md` § 2 的 `QiuqiuBridge` 接口在网页端必须有一个签名完全一致的实现，哪怕方法体是空的。组件永远只面对这一个接口。
3. 键盘交互两端完全相同，包括输入法组字期间不发送这条。
