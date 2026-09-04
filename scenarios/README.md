# 演示场景脚本

每个场景一个 JSON，`POST /scenario/{name}/play` 按时间轴回放。格式：

```json
{
  "name": "knowledge-update",
  "title": "过了三个月",
  "steps": [
    { "at_ms": 0,    "source": "dialogue", "speaker": "user", "text": "我在北京" },
    { "at_ms": 1500, "source": "dialogue", "speaker": "user", "text": "我上周搬到深圳了" },
    { "at_ms": 3000, "source": "dialogue", "speaker": "user", "text": "周末带我逛逛" }
  ],
  "clock_offset_days": 0
}
```

四个场景：`ambient-noise`（99% 是废话）、`time-jump`（过了三个月）、`multi-person`（客厅里有三个人）、`cost-compare`（成本对照）。由 `backend` 分支实现回放，场景内容由 `design` 分支定。
