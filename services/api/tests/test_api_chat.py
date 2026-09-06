"""`POST /chat` 的 SSE 与编排。任务书的验收项在 `test_chat_acceptance` 里。"""

from __future__ import annotations

import json
from typing import Any

import pytest
from api_helpers import parse_sse
from qiuqiu_api.state import AppState
from starlette.testclient import TestClient


def send(client: TestClient, text: str, session_id: str = "s1", **extra: Any) -> list[tuple]:
    response = client.post("/chat", json={"session_id": session_id, "content": text, **extra})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    return parse_sse(response.text)


def test_chat_acceptance(
    client: TestClient, state: AppState, ingest_spy: list[dict[str, Any]]
) -> None:
    """验收：mock 模型发一句话，三类事件按序到达，`ingest` 被调两次。"""
    events = send(client, "我叫赵宁，住在深圳")
    names = [name for name, _ in events]

    assert names[0] == "meta"
    assert "delta" in names
    assert names[-1] == "done"
    assert names.index("meta") < names.index("delta") < names.index("done")
    assert "error" not in names

    assert len(ingest_spy) == 2
    assert [call["speaker"] for call in ingest_spy] == ["user", "assistant"]
    assert {str(call["source"].value) for call in ingest_spy} == {"dialogue"}
    assert len({call["trace_id"] for call in ingest_spy}) == 1


def test_meta_and_done_fields(client: TestClient) -> None:
    events = dict((name, data) for name, data in send(client, "你好"))
    assert set(events["meta"]) == {"model", "memory_used", "recall_ids"}
    assert events["meta"]["model"] == "mock"
    assert set(events["done"]) == {"message_id", "tokens_in", "tokens_out", "latency_ms"}
    assert events["done"]["tokens_out"] > 0


def test_delta_text_reassembles_reply(client: TestClient, state: AppState) -> None:
    events = send(client, "复述一下")
    reply = "".join(data["text"] for name, data in events if name == "delta")
    assert reply
    rows = state.sqlite.list_messages("s1")
    assert [r["role"] for r in rows] == ["user", "assistant"]
    assert rows[1]["content"] == reply


def test_audio_events_when_tts_available(client: TestClient) -> None:
    """mock 注册表有 TTS，就该发 `audio` 事件；没有时跳过而不是报错。"""
    events = send(client, "说句话")
    audio = [data for name, data in events if name == "audio"]
    assert audio, "MODELS_MOCK=1 时 registry 有 TTS，应当发 audio 事件"
    assert set(audio[0]) == {"pcm_b64", "sample_rate", "rms"}
    assert 0.0 <= audio[0]["rms"] <= 1.0


def test_run_metrics_recorded(client: TestClient, state: AppState) -> None:
    send(client, "记一条指标")
    rows = state.sqlite.list_metrics(limit=50)
    stages = {r["stage"] for r in rows}
    assert "orchestrate" in stages
    assert any(s.startswith("chat.") for s in stages)
    assert {r["provider"] for r in rows} >= {"mock"}


def test_second_turn_sees_history(client: TestClient, state: AppState) -> None:
    send(client, "第一句")
    send(client, "第二句")
    rows = state.sqlite.list_messages("s1")
    assert len(rows) == 4


def test_chat_error_event_when_chat_unavailable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """出网失败按 AD-16 发一条带 hint 的 `error` 事件，不静默换 mock。"""
    from qiuqiu_models import registry
    from qiuqiu_models.base import UpstreamError

    real = registry.get("chat")

    async def boom(messages: Any, **kwargs: Any) -> Any:
        raise UpstreamError("上游 500", hint="稍后再试，或检查 DEEPSEEK_API_KEY。")

    monkeypatch.setattr(real, "stream", boom)
    events = send(client, "会失败的一句")
    names = [name for name, _ in events]
    assert names[-1] == "error"
    payload = events[-1][1]
    assert set(payload) == {"code", "message", "hint"}
    assert payload["hint"]


def test_user_message_kept_even_when_model_fails(
    client: TestClient, state: AppState, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ARCHITECTURE § 3：模型这一路失败，原话仍留在 `messages` 表。"""
    from qiuqiu_models import registry
    from qiuqiu_models.base import UpstreamError

    async def boom(messages: Any, **kwargs: Any) -> Any:
        raise UpstreamError("上游 500", hint="稍后再试。")

    monkeypatch.setattr(registry.get("chat"), "stream", boom)
    send(client, "别把我弄丢了")
    rows = state.sqlite.list_messages("s1")
    assert [r["content"] for r in rows] == ["别把我弄丢了"]


def test_image_attachment_goes_through_vision(
    client: TestClient, state: AppState, ingest_spy: list[dict[str, Any]]
) -> None:
    """AD-15：描述由后端调 Vision 生成，和原话一起进 prompt 与 ingest。"""
    blob_id = client.post("/blobs", files={"file": ("a.png", b"\x89PNG fake", "image/png")}).json()[
        "blob_id"
    ]
    events = send(client, "看看这张图", attachments=[{"type": "image", "blob_id": blob_id}])
    assert [name for name, _ in events][0] == "meta"
    assert "【图片】" in ingest_spy[0]["text"]
    assert ingest_spy[0]["blob_id"] == blob_id


def test_empty_content_without_attachment_errors(client: TestClient) -> None:
    events = send(client, "")
    assert events[0][0] == "error"
    assert events[0][1]["hint"]


def test_missing_session_id_is_422_with_hint(client: TestClient) -> None:
    response = client.post("/chat", json={"content": "没有会话"})
    assert response.status_code == 422
    assert response.json()["error"]["hint"]


async def test_chat_streams_without_buffering(app: Any) -> None:
    """首字延迟是第二质量属性：`meta` 必须在整轮跑完之前就到达客户端。

    直接驱动 ASGI 只读前两帧——如果响应被中间件攒成一坨，这里会读不到。
    """
    from api_helpers import SSEProbe

    async with SSEProbe(
        app, "/chat", method="POST", json_body={"session_id": "s1", "content": "边生成边发"}
    ) as probe:
        assert probe.headers["content-type"].startswith("text/event-stream")
        assert probe.headers["x-trace-id"].startswith("trc_")
        frames = await probe.read_frames(2)
    assert frames[0][0] == "meta"
    assert frames[1][0] == "delta"


def test_stage_directions_never_reach_the_client(client: TestClient) -> None:
    """括号旁白在流上就滤掉，delta、落库、TTS 拿到的是同一份文本。

    前端曾经只在显示层擦过一遍：屏幕干净，可语音合成用的是原文——
    丘丘念出来的比屏幕上写的多。
    """
    from qiuqiu_api import orchestrator

    async def fake_deltas(_state, _chat, _messages):
        for piece in ["（愣了一下，随即", "叉腰）", "哼！我", "生气了。", "（别过头去）"]:
            yield piece

    orig = orchestrator._stream_deltas
    orchestrator._stream_deltas = fake_deltas
    try:
        with client.stream("POST", "/chat", json={"session_id": "s1", "content": "生气"}) as res:
            body = res.read().decode()
    finally:
        orchestrator._stream_deltas = orig

    # delta 是一帧一帧发的，拼起来才是这一轮的全文
    spoken = "".join(
        json.loads(line[len("data: ") :])["text"]
        for line in body.splitlines()
        if line.startswith("data: ") and '"text"' in line
    )
    assert spoken == "哼！我生气了。"
    assert "叉腰" not in body, "开头的动作描写不该发给前端"
    assert "别过头去" not in body, "结尾的动作描写也不该发"


async def test_stop_keeps_the_half_sentence_out_of_memory(
    state: AppState, ingest_spy: list[dict[str, Any]]
) -> None:
    """用户按停止：屏幕上留着的半句要在库里，但不进记忆。

    停止走的是前端 `AbortController` → 服务端把这个生成器 `aclose()` 掉，
    `done` 之后的收尾一行都不会执行。半句不落库的话，重开窗口历史里就是
    一句用户的话没有下文。
    """
    from qiuqiu_api.orchestrator import ChatRequest, stream_chat

    stream = stream_chat(
        state, ChatRequest(session_id="s-stop", content="讲个长故事"), trace_id="trc_stop"
    )
    seen: list[str] = []
    async for name, data in stream:
        if name == "delta":
            seen.append(data["text"])
            break  # 相当于用户在第一段就按了停止
    await stream.aclose()

    assert seen, "至少得先收到一段才谈得上停止"
    rows = state.sqlite.list_messages("s-stop")
    assert [r["role"] for r in rows] == ["user", "assistant"]
    assert rows[1]["content"] == "".join(seen).strip()
    # 只有用户那句进了记忆，被掐断的半句没有
    assert [call["speaker"] for call in ingest_spy] == []


def test_nothing_about_expressions_is_sent_to_the_model(state: AppState) -> None:
    """契约 § 9「不往上送」：发给模型的 prompt 里没有任何表情信息。

    模型不知道丘丘脸上在演什么，也就无从配合着演。32 个表情的调度权在前端的
    规则表里（`emotion.ts::RULES` / `event-map.ts::EVENT_EMOTION_TABLE`），
    这一条是那半边的地基——一旦哪天把「当前表情」塞进 prompt，这里就红。
    """
    from qiuqiu_api.orchestrator import build_messages

    messages = build_messages(
        state,
        persona_text="【身份】你叫丘丘。",
        hits=[],
        history=[{"role": "user", "content": "在吗"}],
        user_text="你现在什么心情",
    )
    blob = "\n".join(str(getattr(m, "content", "")) for m in messages)
    for forbidden in ("emotionId", "当前表情", "你现在的表情", "emotion_id"):
        assert forbidden not in blob


def test_its_own_words_are_kept_out_of_what_it_remembers(state: AppState) -> None:
    """丘丘自己说过的话不能混进「你记得的事」——那是幻觉自我强化的入口。

    AD-6 让 AI 的回复也进记忆（不然它答应过的事没法召回），代价是它的猜测也进去了。
    丘丘随口问一句「早上还想喝美式咖啡吧？」，抽出来是一条
    「丘丘询问赵宁是否喝到了美式咖啡」；跟用户真说过的话混在一个列表里发过去，
    模型读不出区别，下一轮就当事实转述并加料，加料的又被 ingest——一圈比一圈像真的。
    """
    from qiuqiu_api.orchestrator import MEMORY_HEADER, SELF_HEADER, build_messages
    from qiuqiu_memory.types import Hit

    hits = [
        Hit(
            id="f1",
            text="用户住在深圳南山",
            path="lexical",
            score=0.9,
            valid_from="",
            speaker="user",
        ),
        Hit(
            id="f2",
            text="丘丘询问赵宁是否喝到了美式咖啡",
            path="lexical",
            score=0.7,
            valid_from="",
            speaker="assistant",
        ),
    ]
    system = build_messages(
        state, persona_text="【身份】你叫丘丘。", hits=hits, history=[], user_text="我在哪"
    )[0].content

    assert MEMORY_HEADER in system and SELF_HEADER in system
    # 用户那条在【记忆】段，丘丘自己那条在【你自己说过的话】段，两段不能串
    remembered = system[system.index(MEMORY_HEADER) : system.index(SELF_HEADER)]
    own = system[system.index(SELF_HEADER) :]
    assert "用户住在深圳南山" in remembered
    assert "美式咖啡" not in remembered
    assert "美式咖啡" in own


def test_only_one_header_shows_up_when_one_side_is_empty(state: AppState) -> None:
    """全是用户说的就不该出现空的「你自己说过的话」标题，反之亦然。"""
    from qiuqiu_api.orchestrator import MEMORY_HEADER, SELF_HEADER, build_messages
    from qiuqiu_memory.types import Hit

    only_theirs = [
        Hit(id="f1", text="用户养了猫", path="lexical", score=0.9, valid_from="", speaker="user")
    ]
    system = build_messages(state, persona_text="", hits=only_theirs, history=[], user_text="?")[
        0
    ].content
    assert MEMORY_HEADER in system and SELF_HEADER not in system


def test_claims_it_made_about_the_user_never_reach_the_prompt(state: AppState) -> None:
    """从丘丘嘴里出来、却写成「用户……」的断言，一条都不端给模型。

    抽取那头已经不写这种了，但库里还躺着一批旧的——同一条判据在拼 prompt 时
    再挡一次。不去删库：里头混着真话（用户说过、丘丘复述了一遍），删掉就把
    真记忆一起丢了。
    """
    from qiuqiu_api.orchestrator import build_messages
    from qiuqiu_memory.types import Hit

    hits = [
        Hit(
            id="a",
            text="用户住在深圳南山",
            path="lexical",
            score=0.9,
            valid_from="",
            speaker="user",
        ),
        Hit(
            id="b",
            text="用户喜欢喝不加糖的美式。",  # 丘丘当初随口说的，用户没说过
            path="lexical",
            score=0.8,
            valid_from="",
            speaker="assistant",
        ),
        Hit(
            id="c",
            text="丘丘答应周三提醒用户练琴。",  # 承诺，AD-6 要的就是这个
            path="lexical",
            score=0.7,
            valid_from="",
            speaker="assistant",
        ),
    ]
    system = build_messages(state, persona_text="", hits=hits, history=[], user_text="?")[0].content

    assert "用户住在深圳南山" in system
    assert "丘丘答应周三提醒用户练琴。" in system
    assert "不加糖" not in system


def test_it_is_told_not_to_invent_memories(state: AppState) -> None:
    """召回为空也要明说「别说你记得任何事」。

    什么都不说的时候它最爱编：实测只给一条「用户正在学吉他」，它就顺出
    「我记得你周末一般抱着吉他练一会儿，累了冲杯美式，天气好还去爬山」——
    后面两件事库里根本没有。
    """
    from qiuqiu_api.orchestrator import MEMORY_HEADER, NO_MEMORY_NOTE, build_messages
    from qiuqiu_memory.types import Hit

    empty = build_messages(state, persona_text="", hits=[], history=[], user_text="我周末干嘛")
    assert NO_MEMORY_NOTE in empty[0].content

    one = build_messages(
        state,
        persona_text="",
        hits=[
            Hit(
                id="a",
                text="用户正在学吉他。",
                path="lexical",
                score=0.9,
                valid_from="",
                speaker="user",
            )
        ],
        history=[],
        user_text="我周末干嘛",
    )
    system = one[0].content
    assert MEMORY_HEADER in system and NO_MEMORY_NOTE not in system
    assert "这张表之外的事，你不知道" in system


def test_an_empty_recall_does_not_make_it_deny_having_memory(state: AppState) -> None:
    """「这一句没召回到」不等于「我记不住东西」。

    第一版写的是「什么都没召回到，别说你记得任何事」，模型读成了「你根本没有记忆」——
    实测回「我不会真正把这事儿存下来，你最好自己记到日历里」。对一个主打长期记忆的
    产品来说，这比编造更糟。
    """
    from qiuqiu_api.orchestrator import NO_MEMORY_NOTE, build_messages

    system = build_messages(state, persona_text="", hits=[], history=[], user_text="帮我记着")[
        0
    ].content
    assert NO_MEMORY_NOTE in system
    assert "不是你记不住东西" in system
    assert "照常会被记下来" in system

def test_system_prompt_carries_today() -> None:
    """系统提示里得有今天几号、周几。

    没这一句时实测过一次：记忆里是「用户计划在 2026 年 9 月 11 日去上海出差」，
    用户嘴上说的是「下周五」，丘丘反问「你说的下周五跟 9 月 11 日对不太上啊，
    是改时间了吗」——9 月 11 日**就是**那个周五，它只是不知道今天几号、没法换算。
    """
    import datetime as dt

    from qiuqiu_api.orchestrator import today_line

    line = today_line(dt.datetime(2026, 9, 6, 4, 0, tzinfo=dt.UTC))
    assert line.startswith("今天是 2026 年 9 月 6 日，周")
    assert line.rstrip("。")[-1] in "一二三四五六日"

