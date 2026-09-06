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

## `clock_offset_days` 拉开的是「说」和「问」之间的距离

写入按**此刻**记，`query` 那几步站在偏移之后的那一天问；第一次提问之前，用那一天的
时钟跑一遍降冷。两边都加偏移的话，说和问是同一时刻，事实还热着——「过了三个月」
演出来就只是一次普通召回，看不到「热表没有 → 下探冷表 → 命中整条回热」。

降冷是归档不是删除，命中会回热，夜里的定时任务做的也是同一件事。所以点一次
`time-jump` 会把热表里超过 30 天没命中的事实搬进冷表，响应里的 `demoted` 报数量。

## 回放前会清一次筛选器的去重窗口

同一个脚本点第二次，上一次的句子还在窗口里，每一句都判「重复」，
「99% 是废话，但那 1% 记住了」就演不出来了。一次回放是一段独立的模拟会话。
