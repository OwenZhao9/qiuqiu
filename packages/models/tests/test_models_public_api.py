"""公开面的契约：上层只能看到 base 与 registry，看不到 providers（AD-8）。"""

from __future__ import annotations

import inspect
import subprocess
import sys
from pathlib import Path

import pytest
import qiuqiu_models
from qiuqiu_models import base, registry


def test_providers_not_in_public_exports() -> None:
    assert "providers" not in qiuqiu_models.__all__


def test_importing_the_package_does_not_load_providers() -> None:
    """新进程里只 import qiuqiu_models，providers 不该被拉进来（registry 是懒加载的）。"""

    code = (
        "import sys, qiuqiu_models; "
        "print(sorted(m for m in sys.modules if m.startswith('qiuqiu_models.providers')))"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "[]"


def test_public_exports_only_come_from_base_and_registry() -> None:
    allowed = (
        set(base.__all__)
        | set(registry.__all__)
        | {
            "__version__",
            "base",
            "metrics",
            "registry",
        }
    )
    assert set(qiuqiu_models.__all__) <= allowed
    for name in qiuqiu_models.__all__:
        assert hasattr(qiuqiu_models, name), name


def test_no_provider_class_leaks_into_public_exports() -> None:
    for name in qiuqiu_models.__all__:
        obj = getattr(qiuqiu_models, name)
        module = getattr(obj, "__module__", "") or getattr(obj, "__name__", "")
        assert "qiuqiu_models.providers" not in module, name


def test_only_registry_imports_providers() -> None:
    """源码级检查：除了 registry 自己，包里没有别的模块 import providers。"""

    pkg_dir = Path(inspect.getfile(qiuqiu_models)).parent
    offenders = []
    for path in pkg_dir.rglob("*.py"):
        if path.parent.name == "providers" or path.name == "registry.py":
            continue
        text = path.read_text(encoding="utf-8")
        if "from .providers" in text or "from qiuqiu_models.providers" in text:
            offenders.append(path.name)
    assert offenders == []


@pytest.mark.parametrize(
    "name",
    ["ChatModel", "VisionModel", "ASR", "VAD", "TTS", "RealtimeVoice"],
)
def test_six_protocols_exist(name: str) -> None:
    assert hasattr(base, name)


def _sig(fn: object) -> str:
    return str(inspect.signature(fn, eval_str=True))


def test_contract_signatures_match_contracts_md() -> None:
    """签名逐字对 CONTRACTS § 4。改了这里就得先改契约。"""

    assert _sig(base.ChatModel.stream) == (
        "(self, messages: list[qiuqiu_models.base.Message], *, temperature: float = 0.7)"
        " -> collections.abc.AsyncIterator[str]"
    )
    assert _sig(base.ChatModel.complete) == (
        "(self, messages: list[qiuqiu_models.base.Message]) -> str"
    )
    assert _sig(base.VisionModel.describe) == ("(self, image: bytes | str, prompt: str) -> str")
    assert _sig(base.ASR.transcribe) == ("(self, pcm16k: bytes) -> qiuqiu_models.base.Transcript")
    assert _sig(base.ASR.stream) == (
        "(self, chunks: collections.abc.Iterator[bytes])"
        " -> collections.abc.Iterator[qiuqiu_models.base.PartialTranscript]"
    )
    assert _sig(base.VAD.evaluate) == ("(self, pcm16k: bytes) -> qiuqiu_models.base.VadResult")
    assert _sig(base.TTS.synthesize) == (
        "(self, text: str, *, voice: str)"
        " -> collections.abc.AsyncIterator[qiuqiu_models.base.AudioChunk]"
    )
    assert _sig(base.RealtimeVoice.open) == ("(self, *, system_prompt: str, voice: str) -> None")
    assert _sig(base.RealtimeVoice.send) == "(self, pcm16k: bytes) -> None"
    assert _sig(base.RealtimeVoice.interrupt) == "(self) -> None"
    assert _sig(base.RealtimeVoice.events) == (
        "(self) -> collections.abc.AsyncIterator[qiuqiu_models.base.RealtimeEvent]"
    )
    assert _sig(base.RealtimeVoice.close) == "(self) -> None"


def test_realtime_event_dict_shapes_match_contract() -> None:
    audio = base.RealtimeEvent(type="audio", pcm=b"\x00\x01", rms=0.5)
    assert audio.to_dict() == {"type": "audio", "pcm": b"\x00\x01", "rms": 0.5}

    tr = base.RealtimeEvent(type="transcript", role="user", text="你好", final=True)
    assert tr.to_dict() == {
        "type": "transcript",
        "role": "user",
        "text": "你好",
        "final": True,
    }

    assert base.RealtimeEvent(type="turn_end").to_dict() == {"type": "turn_end"}


def test_model_error_envelope_matches_contract() -> None:
    err = base.ModelError("坏了", hint="重试一次", code="model.demo")
    assert err.to_dict() == {"error": {"code": "model.demo", "message": "坏了", "hint": "重试一次"}}
