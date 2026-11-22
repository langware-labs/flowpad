"""The lw blocks of one markdown doc: find them, validate them, render them."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import ValidationError

from flow_sdk.schema.data_spec.lw_spec import BLOCK_KINDS, BLOCK_SPECS

#: A fence line as CommonMark reads it: up to three spaces of indent, then the marker and the info string.
_FENCE = re.compile(r"^( {0,3})(`{3,}|~{3,})(.*)$")


@dataclass
class Block:
    """One block as it sits in a doc. ``spec`` is None when the body is not valid."""

    path: Path
    line: int  # 1-based line of the opening fence
    end_line: int  # 1-based line of the closing fence
    kind: str
    spec: Optional[Any] = None
    problems: list[str] = field(default_factory=list)
    indent: str = ""  # what the fence is indented by (a block inside a list item)

    @property
    def tag(self) -> str:
        return self.spec.tag if self.spec else ""

    @property
    def depends_on(self) -> list[str]:
        return list(self.spec.depends_on) if self.spec else []

    @property
    def items(self) -> list[Any]:
        return list(self.spec.statements) if self.spec else []


def validate(kind: str, data: Any) -> tuple[Optional[Any], list[str]]:
    """A block body against its schema: the value, or what is wrong with it."""
    if not isinstance(data, dict):
        return None, ["the block body must be a YAML mapping"]
    try:
        return BLOCK_SPECS[kind].model_validate(data), []
    except ValidationError as exc:
        return None, [_problem(error) for error in exc.errors()]


def _problem(error: dict) -> str:
    where = ".".join(str(part) for part in error["loc"])
    message = error["msg"].removeprefix("Value error, ")
    if error["type"] == "extra_forbidden":
        message = "unknown field"
    return f"{where}: {message}" if where else message


def parse_blocks(text: str, path: Path) -> list[Block]:
    """Every lw block of one doc — what a markdown reader sees as a code block whose language is
    one of ``BLOCK_KINDS``, whatever its fence (backticks or tildes, any length, indented
    up to three spaces). A block shown inside another fence, as docs do for examples, is text and not
    a block; so is a fence that is never closed."""
    lines = text.split("\n")
    blocks, i = [], 0
    while i < len(lines):
        opened = _FENCE.match(lines[i].rstrip("\r"))
        if not opened:
            i += 1
            continue
        indent, marker, info = opened.group(1), opened.group(2), opened.group(3).strip()
        close = i + 1
        while close < len(lines) and not _closes(lines[close], marker):
            close += 1
        if info in BLOCK_KINDS and close < len(lines):
            body = "\n".join(_dedent(line.rstrip("\r"), indent) for line in lines[i + 1:close])
            try:
                spec, problems = validate(info, yaml.safe_load(body))
            except yaml.YAMLError as exc:
                spec, problems = None, [f"invalid YAML: {str(exc).splitlines()[0]}"]
            blocks.append(Block(path, i + 1, close + 1, info, spec, problems, indent))
        i = close + 1
    return blocks


def _dedent(line: str, indent: str) -> str:
    return line[len(indent):] if line.startswith(indent) else line.lstrip(" ")


def _closes(line: str, marker: str) -> bool:
    """A closing fence: the same character, at least as long, nothing after it."""
    stripped = line.strip()
    return len(stripped) >= len(marker) and set(stripped) == {marker[0]} and len(line) - len(line.lstrip(" ")) <= 3


class _Indented(yaml.SafeDumper):
    def increase_indent(self, flow=False, indentless=False):
        return super().increase_indent(flow, False)


def render_block(spec: Any) -> str:
    """The block's text as it is stored, fence included. Field order is fixed; a field left at
    its default is not written."""
    data = spec.model_dump(exclude_defaults=True, exclude_none=True)
    ordered = {name: data[name] for name in spec.fields if data.get(name)}
    dumped = yaml.dump(ordered, Dumper=_Indented, sort_keys=False, allow_unicode=True, default_flow_style=False, width=10000)
    return f"```{spec.kind}\n{dumped}```"
