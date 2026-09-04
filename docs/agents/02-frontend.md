# 前端 Agent · `frontend`

Electron 壳 + React 界面。两端共用一套 React 代码。

## 目录

`apps/desktop/`（Electron 主进程、preload）和 `apps/web/`（React）。

## 先读

- `docs/CONTRACTS.md` § 1 HTTP 与 SSE、§ 2 IPC、§ 6 表情映射
- `design/interaction.md`、`design/memory-panel.md`、`design/tokens.css`
- `packages/character` 的导出接口（等 `character` 分支合并后）

## 功能清单

### Electron（`apps/desktop`）

- [ ] 桌宠窗口：透明、无边框、置顶（`screen-saver` 层级）、`skipTaskbar`、可拖动
- [ ] 主窗口：三栏，无边框，托盘点击显隐
- [ ] 托盘：打开主窗口 / 显示隐藏丘丘 / 重置位置 / 退出
- [ ] 全局快捷键唤起桌宠输入条
- [ ] preload 暴露 `window.qiuqiu`，签名严格按 CONTRACTS § 2
- [ ] **主窗口是唯一 SSE 持有者**：收到 delta 经 `forwardDelta` 转发桌宠窗口
- [ ] 后端地址注入 `window.__QIUQIU_API__`
- [ ] Windows 打包脚本，透明窗口在 Windows 验证

### React（`apps/web`）

- [ ] 桌宠页 `pet.html`：丘丘渲染、气泡、内联输入条、拖拽、右键
- [ ] 主窗口 `index.html`：对话面板、记忆事件侧栏、记忆库页、人格设置页、阈值面板、场景控制台
- [ ] `api.ts`：REST 封装 + SSE 解析（`/chat` 与 `/events` 两条流）+ 断线续传
- [ ] 对话面板：流式渲染、回复下方「参考了 N 条记忆」可点开
- [ ] 记忆事件侧栏：按 `design/memory-panel.md` 渲染四类事件
- [ ] 人格设置页：四个预设卡片 + 四个滑块 + 「不设」开关 + 「重置相处性格」按钮
- [ ] 阈值面板：滑块拖动实时 `PUT /config/thresholds`
- [ ] 场景控制台：列出 `scenarios/*.json`，一键回放
- [ ] 状态机驱动：发送时切 `thinking`，首 delta 切 `speaking`，done 后回 `idle`——**本地切换，不等后端**
- [ ] 网页端适配：无 `window.qiuqiu` 时降级，丘丘嵌在页面里

## 约束

- 状态切换不走后端
- 桌宠窗口不自己连 SSE，只收 IPC 转发
- 不在前端做任何记忆逻辑，侧栏只渲染事件
- 密钥不落前端，`/providers` 只看 `has_key`

## 验收

- 两个窗口同时打开，主窗口发一句话，桌宠气泡与对话面板同步逐字显示
- 断网重连后 `/events` 从上次游标续传，侧栏不丢事件
- 网页端在无 Electron 环境下全部功能可用（桌宠功能除外）
- `pnpm test` 通过；SSE 解析有单测

## 与其他分支

- 依赖 `backend` 的路由与 SSE 格式
- 依赖 `character` 导出的 `createQiuqiu()`、`setState()`、`applyEvent()`
- 依赖 `design` 的令牌与交互规范
