"""豆包端到端实时语音的二进制帧编解码。

协议是自定义二进制，不是 JSON over WebSocket。一帧四段：

    header(4B) | optional(变长) | payload size(4B) | payload

header 四个字节：

    byte0  高 4 位 协议版本（固定 1）      低 4 位 header 长度（固定 1，即 4 字节）
    byte1  高 4 位 消息类型                低 4 位 类型标志位
    byte2  高 4 位 序列化方式              低 4 位 压缩方式
    byte3  保留，0

optional 段按固定顺序拼：先 error code（仅错误帧），再 sequence（本项目不用），
再 event id（本项目全部帧都带），最后 connect id 或 session id——**只有会话类事件
才带 session id**，连接类事件不带，带错了服务端直接断。

payload 要么是 JSON 字符串，要么是裸 PCM。序列化位跟着变：JSON 是 1，音频是 0。

字节序全部大端。这一点文档没明说，是从示例帧
`[17 20 16 0 0 0 0 1 0 0 0 2 123 125]` 反推的：`0 0 0 1` 是 event=1（StartConnection），
`0 0 0 2` 是 payload 长度 2，payload `123 125` 就是 `{}`。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any

PROTOCOL_VERSION = 0b0001
HEADER_SIZE_UNITS = 0b0001


class MsgType(IntEnum):
    """header byte1 的高 4 位。"""

    FULL_CLIENT = 0b0001  # 客户端发文本事件
    FULL_SERVER = 0b1001  # 服务端回文本事件
    AUDIO_CLIENT = 0b0010  # 客户端发音频
    AUDIO_SERVER = 0b1011  # 服务端回音频
    ERROR = 0b1111


#: byte1 低 4 位：0b0100 表示 optional 段里带 event id。本项目所有帧都带。
FLAG_WITH_EVENT = 0b0100

SERIAL_RAW = 0b0000  # 音频
SERIAL_JSON = 0b0001
COMPRESS_NONE = 0b0000


class Event(IntEnum):
    """客户端与服务端事件 ID。取值见接入文档 § 2.3。"""

    # 客户端
    START_CONNECTION = 1
    FINISH_CONNECTION = 2
    START_SESSION = 100
    FINISH_SESSION = 102
    TASK_REQUEST = 200  # 上传音频
    SAY_HELLO = 300
    CHAT_TEXT_QUERY = 501  # 用文本发起一轮，替代音频输入

    # 服务端 · 连接
    CONNECTION_STARTED = 50
    CONNECTION_FAILED = 51
    CONNECTION_FINISHED = 52
    # 服务端 · 会话
    SESSION_STARTED = 150
    SESSION_FINISHED = 152
    SESSION_FAILED = 153
    USAGE_RESPONSE = 154
    # 服务端 · 合成
    TTS_SENTENCE_START = 350
    TTS_SENTENCE_END = 351
    TTS_RESPONSE = 352  # payload 是音频
    TTS_ENDED = 359
    # 服务端 · 识别
    ASR_INFO = 450  # 听到首字，客户端该停播打断
    ASR_RESPONSE = 451
    ASR_ENDED = 459
    # 服务端 · 回复文本
    CHAT_RESPONSE = 550
    CHAT_ENDED = 559
    DIALOG_ERROR = 599


#: 需要在 optional 段携带 session id 的事件。连接类事件带了会被服务端拒。
SESSION_EVENTS = frozenset(
    {
        Event.START_SESSION,
        Event.FINISH_SESSION,
        Event.TASK_REQUEST,
        Event.SAY_HELLO,
        Event.CHAT_TEXT_QUERY,
    }
)


@dataclass(slots=True)
class Frame:
    """解出来的一帧。"""

    msg_type: MsgType
    event: Event | int | None = None
    session_id: str | None = None
    payload: bytes = b""
    error_code: int | None = None
    json_payload: dict[str, Any] = field(default_factory=dict)


def _header(msg_type: MsgType, *, serial: int) -> bytes:
    return bytes(
        (
            (PROTOCOL_VERSION << 4) | HEADER_SIZE_UNITS,
            (int(msg_type) << 4) | FLAG_WITH_EVENT,
            (serial << 4) | COMPRESS_NONE,
            0,
        )
    )


def _u32(value: int) -> bytes:
    return value.to_bytes(4, "big")


def encode(
    event: Event,
    *,
    payload: bytes | dict[str, Any] | None = None,
    session_id: str | None = None,
) -> bytes:
    """组一帧。`payload` 是 dict 走 JSON，是 bytes 走裸音频。"""
    if isinstance(payload, bytes):
        body, serial, msg_type = payload, SERIAL_RAW, MsgType.AUDIO_CLIENT
    else:
        # 紧凑分隔符：`json.dumps` 默认在 `: ` 和 `, ` 后加空格，白占字节。
        # 文档给的真实帧就是紧凑的，对齐它才好逐字节比对。
        body = json.dumps(
            payload if payload is not None else {},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode()
        serial, msg_type = SERIAL_JSON, MsgType.FULL_CLIENT

    out = bytearray(_header(msg_type, serial=serial))
    out += _u32(int(event))
    if event in SESSION_EVENTS:
        if not session_id:
            raise ValueError(f"事件 {event.name} 属于会话类，必须带 session_id")
        sid = session_id.encode()
        out += _u32(len(sid)) + sid
    out += _u32(len(body)) + body
    return bytes(out)


def decode(raw: bytes) -> Frame:
    """拆一帧。字段顺序与 `encode` 对称。"""
    if len(raw) < 4:
        raise ValueError(f"帧太短，只有 {len(raw)} 字节")
    msg_type_bits = raw[1] >> 4
    flags = raw[1] & 0x0F
    serial = raw[2] >> 4
    try:
        msg_type = MsgType(msg_type_bits)
    except ValueError as exc:
        raise ValueError(f"未知消息类型 0b{msg_type_bits:04b}") from exc

    pos = 4 * HEADER_SIZE_UNITS
    frame = Frame(msg_type=msg_type)

    if msg_type is MsgType.ERROR:
        frame.error_code = int.from_bytes(raw[pos : pos + 4], "big")
        pos += 4
    if flags & FLAG_WITH_EVENT:
        code = int.from_bytes(raw[pos : pos + 4], "big")
        pos += 4
        try:
            frame.event = Event(code)
        except ValueError:
            frame.event = code  # 文档外的新事件，原样带出去，别炸
    if frame.event in SESSION_EVENTS or (
        isinstance(frame.event, Event) and 150 <= int(frame.event) < 600
    ):
        # 服务端的会话类事件同样带 session id
        size = int.from_bytes(raw[pos : pos + 4], "big")
        pos += 4
        frame.session_id = raw[pos : pos + size].decode("utf-8", "replace")
        pos += size

    size = int.from_bytes(raw[pos : pos + 4], "big")
    pos += 4
    frame.payload = raw[pos : pos + size]
    if serial == SERIAL_JSON and frame.payload:
        try:
            parsed = json.loads(frame.payload)
            if isinstance(parsed, dict):
                frame.json_payload = parsed
        except json.JSONDecodeError:
            pass
    return frame
