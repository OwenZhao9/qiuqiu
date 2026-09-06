# 托管版

一个进程同时端出前端静态页和后端 API：后端挂在 `/api`，`vite build` 的产物挂在 `/`。
前端 `apiBase()` 默认就打同源的 `/api`，所以前端一行都不用改。

## 为什么不能把 key 放进仓库

这个仓库是公开的。提交进去的 key，GitHub 的 secret scanning 和扒公开仓库的
机器人通常几分钟内命中，供应商会直接吊销，吊销之前余额先被人跑掉；而且调用
记录算在实名认证的账号上。同理，静态站（GitHub Pages / Cloudflare Pages）也
放不了——网页要直接调模型就得把 key 写进 JS，按 F12 就看得到。

**key 只能待在服务端的加密变量里。** 这也是这个目录存在的理由。

## 要设的环境变量

| 变量 | 干什么 |
|---|---|
| `DEEPSEEK_API_KEY` | 对话与看图 |
| `VOLC_SPEECH_APPID` / `VOLC_SPEECH_TOKEN` | 朗读与实时语音，不设就只有文字 |
| `DEMO_PASSWORD` | 访问口令。设了就要 `?k=口令` 进一次，之后种 cookie；不设完全开放 |
| `DATA_DIR` | 数据落哪儿，默认 `/data` |

## 本地验一遍

    pnpm --filter @qiuqiu/web build
    DATA_DIR=/tmp/qq QIUQIU_WEB_DIR=$PWD/apps/web/dist DEMO_PASSWORD=试用 \
      uv run uvicorn deploy.server:app --port 8099

然后开 `http://127.0.0.1:8099/?k=试用`。

## 注意

- **数据不一定留得住。** 平台没给持久卷时，重启就从空库开始——对演示反而干净：
  别人打开就是一个空记忆的丘丘，说什么记什么。
- 实时通话要麦克风和 WSS，浏览器里演示价值不大，可以不设 `VOLC_*`。
