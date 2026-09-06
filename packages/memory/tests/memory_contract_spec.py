"""从 `docs/CONTRACTS.md` **解析**出契约，供契约测试断言。

为什么要解析而不是在测试里抄一份表：抄表的契约测试只能证明「代码和测试一致」，
证明不了「代码和契约一致」——契约改了、测试跟着改了，两边一起漂走，没人发现。
这份模块把 CONTRACTS.md 当成唯一事实源读进来，测试拿解析结果去对代码。文档改一个字，
测试立刻炸在对应那条上。

解析四处：

- § 1 的事件信封与四类 payload（伪 JSON，逐层取键名）
- § 1 的 `VisibleMemory` / `Sliders` / `Learned` / `Thresholds`（TypeScript 声明）
- § 3 的两段 Python（`ast` 直接解析——那两段本来就是合法 Python）
- § 5 的 LanceDB `facts` 字段表（Markdown 表格）

伪 JSON 不是合法 JSON（值写的是 `string` `0–1` `("semantic"|"lexical")[]` 这类类型名），
所以自己写了个只认结构不认值的括号扫描器：认键、认嵌套、把值原样留成 `raw` 字符串，
需要取值域时再从 `raw` 里抠引号里的字面量。
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

__all__ = [
    "CONTRACTS_PATH",
    "MethodSpec",
    "Node",
    "contracts_text",
    "factory_defaults",
    "dataclass_defaults",
    "dataclass_fields",
    "declared_version",
    "enum_members",
    "envelope_keys",
    "event_payload_shapes",
    "event_types",
    "facts_columns",
    "ingest_decision_values",
    "method_specs",
    "parse_object",
    "persona_composition_order",
    "python_block",
    "section",
    "sqlite_table_columns",
    "threshold_defaults",
    "ts_interface_fields",
]

CONTRACTS_PATH = Path(__file__).resolve().parents[3] / "docs" / "CONTRACTS.md"


@lru_cache(maxsize=1)
def contracts_text() -> str:
    return CONTRACTS_PATH.read_text(encoding="utf-8")


def declared_version() -> str:
    """文档顶部声明的当前契约版本，形如 `v0.1.6`。"""
    found = re.search(r"当前：\*\*(v[\d.]+)\*\*", contracts_text())
    assert found, "CONTRACTS.md 里找不到「当前：**vX.Y.Z**」"
    return found.group(1)


def section(number: int) -> str:
    """取 `## n · 标题` 到下一个 `## ` 之间的正文。"""
    text = contracts_text()
    start = re.search(rf"^## {number} · ", text, re.MULTILINE)
    assert start, f"CONTRACTS.md 里没有第 {number} 节"
    rest = text[start.end() :]
    end = re.search(r"^## ", rest, re.MULTILINE)
    return rest[: end.start()] if end else rest


# --------------------------------------------------------------------------- 伪 JSON


@dataclass(slots=True)
class Node:
    """伪 JSON 里的一个值。`fields` 非空表示它是个对象（或对象数组）。"""

    raw: str
    fields: dict[str, Node] = field(default_factory=dict)

    @property
    def keys(self) -> set[str]:
        return set(self.fields)

    @property
    def literals(self) -> list[str]:
        """`raw` 里所有引号字面量。取值域（`"accept"|"reject"|"uncertain"`）从这儿来。"""
        return re.findall(r'"([^"]*)"', self.raw)

    def __getitem__(self, key: str) -> Node:
        return self.fields[key]


_CLOSERS = {"{": "}", "[": "]", "(": ")"}


def _skip_ws(text: str, i: int) -> int:
    while i < len(text) and text[i].isspace():
        i += 1
    return i


def _read_group(text: str, i: int) -> tuple[str, int]:
    """从一个开括号读到与它配对的闭括号，返回含括号的原文与其后的位置。"""
    opener = text[i]
    closer = _CLOSERS[opener]
    depth, start = 0, i
    while i < len(text):
        char = text[i]
        if char == '"':
            _, i = _read_string(text, i)
            continue
        if char in _CLOSERS:
            depth += 1
        elif char in _CLOSERS.values():
            depth -= 1
            if depth == 0 and char == closer:
                return text[start : i + 1], i + 1
        i += 1
    raise ValueError(f"括号没闭合：{text[start : start + 40]!r}")


def _read_string(text: str, i: int) -> tuple[str, int]:
    assert text[i] == '"'
    end = text.index('"', i + 1)
    return text[i + 1 : end], end + 1


def _skip_scalar(text: str, i: int) -> int:
    """跳过一个标量值：扫到同层的逗号或闭括号为止，括号成对的一律跳过。"""
    while i < len(text):
        char = text[i]
        if char == '"':
            _, i = _read_string(text, i)
            continue
        if char in _CLOSERS:
            _, i = _read_group(text, i)
            continue
        if char in ",}]":
            return i
        i += 1
    return i


def parse_object(text: str, i: int = 0) -> Node:
    """解析一个 `{...}` 对象。键名逐字取，值只留原文，嵌套对象递归展开。"""
    i = _skip_ws(text, i)
    raw, _ = _read_group(text, i)
    body, cursor = raw, 1
    fields: dict[str, Node] = {}
    while cursor < len(body):
        cursor = _skip_ws(body, cursor)
        if cursor >= len(body) or body[cursor] == "}":
            break
        if body[cursor] == ",":
            cursor += 1
            continue
        if body[cursor] != '"':
            # 不是键（例如信封里的 `{ ... }` 占位），跳过
            cursor = _skip_scalar(body, cursor)
            continue
        key, cursor = _read_string(body, cursor)
        cursor = _skip_ws(body, cursor)
        if cursor < len(body) and body[cursor] == ":":
            cursor += 1
            value, cursor = _parse_value(body, cursor)
            fields[key] = value
    return Node(raw=raw, fields=fields)


def _parse_value(text: str, i: int) -> tuple[Node, int]:
    i = _skip_ws(text, i)
    if i >= len(text):
        return Node(raw=""), i
    if text[i] == "{":
        raw, end = _read_group(text, i)
        return parse_object(raw), end
    if text[i] == "[":
        raw, end = _read_group(text, i)
        inner = raw.find("{")
        # `[{...}]` 是「对象数组」，把元素形状也展开
        return (parse_object(raw[inner:]) if inner != -1 else Node(raw=raw)), end
    end = _skip_scalar(text, i)
    return Node(raw=text[i:end].strip()), end


# --------------------------------------------------------------------------- § 1


def _fence_after(marker: str, *, lang: str = "") -> str:
    """取 `marker` 之后的第一个代码围栏内容。"""
    text = contracts_text()
    at = text.index(marker)
    opener = re.compile(rf"^```{lang}\s*$", re.MULTILINE)
    start = opener.search(text, at)
    assert start, f"{marker!r} 之后没有 ```{lang} 围栏"
    end = text.index("\n```", start.end())
    return text[start.end() : end]


def envelope_keys() -> list[str]:
    """§ 1 统一信封的键，**按文档里的顺序**。"""
    return list(parse_object(_fence_after("统一信封：", lang="json")).fields)


def event_types() -> set[str]:
    """信封 `type` 的取值域。"""
    return set(parse_object(_fence_after("统一信封：", lang="json"))["type"].literals)


def event_payload_shapes() -> dict[str, Node]:
    """四类 payload 的形状，键是事件类型。"""
    block = _fence_after("payload 按类型：")
    shapes: dict[str, Node] = {}
    for match in re.finditer(r"^(\w+)\s*→\s*(?=\{)", block, re.MULTILINE):
        shapes[match.group(1)] = parse_object(block, match.end())
    return shapes


def ts_interface_fields(name: str) -> list[str]:
    """一段 TypeScript `interface` / `type` 声明里的字段名，按声明顺序。"""
    text = contracts_text()
    found = re.search(rf"(?:interface|type)\s+{name}\s*=?\s*(\{{)", text)
    assert found, f"CONTRACTS.md 里没有 {name} 的声明"
    body, _ = _read_group(text, found.start(1))
    names: list[str] = []
    # `interface` 用 `;` 分隔、`type` 用 `,`，两种都切；联合类型写的是 `|`，不会误伤
    for raw in re.split(r"[;,\n]", body.strip("{}")):
        hit = re.match(r"\s*(\w+)\??\s*:", raw)
        if hit and hit.group(1) not in names:
            names.append(hit.group(1))
    return names


def threshold_defaults() -> dict[str, float]:
    """§ 1 `Thresholds` 那行注释里写的默认值。"""
    text = contracts_text()
    line = next(ln for ln in text.split("\n") if "type Thresholds" in ln)
    names = re.findall(r"(\w+)\s*:\s*number", line)
    numbers = [float(n) for n in re.findall(r"(\d+\.\d+)", line)]
    assert len(names) == len(numbers), f"Thresholds 的字段与默认值对不上：{line}"
    return dict(zip(names, numbers, strict=True))


def ingest_decision_values() -> set[str]:
    """`POST /ingest` 响应体里 `decision` 的取值域。"""
    text = contracts_text()
    at = text.index('Response: { "trace_id": string, "decision"')
    return set(parse_object(text, text.index("{", at))["decision"].literals)


# --------------------------------------------------------------------------- § 3


def _parseable(source: str) -> str:
    """把契约里的「签名速写」补成合法 Python：去行尾注释，给没有函数体的 `def` 补 `: ...`。

    契约里 `PersonaService.current()` 那几行写的是 `def current(self) -> str  # 说明`，
    人看没问题，`ast` 看是语法错。补的只是标点，参数与注解一个字没动。
    """
    lines: list[str] = []
    for line in source.split("\n"):
        body = line.split("#", 1)[0].rstrip()
        if body.lstrip().startswith("def ") and not body.endswith((":", "...", ",")):
            body += ": ..."
        lines.append(body)
    return "\n".join(lines)


def python_block(index: int = 0) -> ast.Module:
    """§ 3 的第 `index` 段 Python 的 AST。"""
    blocks = re.findall(r"^```python\s*\n(.*?)\n```", section(3), re.MULTILINE | re.DOTALL)
    assert len(blocks) > index, f"§ 3 里没有第 {index} 段 python"
    return ast.parse(_parseable(blocks[index]))


def _class_def(module: ast.Module, name: str) -> ast.ClassDef:
    for node in module.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    raise AssertionError(f"契约里没有 class {name}")


def enum_members(name: str = "Source") -> dict[str, str]:
    """枚举成员名 → 字面值。"""
    out: dict[str, str] = {}
    for node in _class_def(python_block(0), name).body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            out[node.targets[0].id] = node.value.value  # type: ignore[union-attr]
    return out


def dataclass_fields(name: str, *, block: int = 0) -> list[str]:
    """契约里某个 dataclass 的字段名，按声明顺序。"""
    return [
        node.target.id  # type: ignore[union-attr]
        for node in _class_def(python_block(block), name).body
        if isinstance(node, ast.AnnAssign)
    ]


def dataclass_defaults(name: str, *, block: int = 0) -> dict[str, object]:
    """契约里某个 dataclass 写死的默认值（只取字面量）。"""
    out: dict[str, object] = {}
    for node in _class_def(python_block(block), name).body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.value, ast.Constant):
            out[node.target.id] = node.value.value  # type: ignore[union-attr]
    return out


@dataclass(slots=True)
class MethodSpec:
    """契约里一个方法的签名：参数名、哪些是关键字限定、哪些有默认值。"""

    name: str
    positional: list[str]
    keyword_only: list[str]
    defaults: set[str]

    @property
    def parameters(self) -> list[str]:
        return [*self.positional, *self.keyword_only]


def method_specs(class_name: str, *, block: int = 0) -> dict[str, MethodSpec]:
    """一个类里所有方法的签名规格。"""
    specs: dict[str, MethodSpec] = {}
    for node in _class_def(python_block(block), class_name).body:
        if not isinstance(node, ast.FunctionDef):
            continue
        args = node.args
        defaulted = {a.arg for a, d in zip(args.kwonlyargs, args.kw_defaults, strict=True) if d}
        if args.defaults:
            defaulted.update(a.arg for a in args.args[-len(args.defaults) :])
        specs[node.name] = MethodSpec(
            name=node.name,
            positional=[a.arg for a in args.args],
            keyword_only=[a.arg for a in args.kwonlyargs],
            defaults=defaulted,
        )
    return specs


# --------------------------------------------------------------------------- § 5


def facts_columns() -> list[str]:
    """§ 5 LanceDB `facts` 表的字段名，按表格顺序。"""
    body = section(5)
    start = body.index("### LanceDB")
    end = body.index("### SQLite")
    names: list[str] = []
    for line in body[start:end].split("\n"):
        hit = re.match(r"\|\s*`([^`]+)`\s*\|", line)
        if hit:
            names.append(hit.group(1))
    assert names, "§ 5 的 facts 表格解析不出字段"
    return names


def sqlite_table_columns(table: str) -> list[str]:
    """§ 5 SQL 块里某张表的列名。"""
    block = _fence_after("### SQLite", lang="sql")
    line = next(ln for ln in block.split("\n") if ln.strip().startswith(f"{table}("))
    inner = line[line.index("(") + 1 : line.index(")")]
    return [c.strip() for c in inner.split(",")]


# --------------------------------------------------------------------------- § 7


def persona_composition_order() -> list[str]:
    """§ 7 合成公式里三段的顺序。"""
    block = _fence_after("## 7 · 人格合成规则")
    return [name for name in re.findall(r"(\w+_block)", block)]


def factory_defaults() -> dict[str, str]:
    """§ 9 那张出厂表：项 → 出厂值。`|` 表格逐行读，反引号剥掉。"""
    rows: dict[str, str] = {}
    for line in section(9).splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 2 or cells[0] in {"项", "---"} or set(cells[0]) <= {"-"}:
            continue
        rows[cells[0]] = cells[1].strip("`")
    assert rows, "CONTRACTS.md § 9 里没解析到出厂表"
    return rows
