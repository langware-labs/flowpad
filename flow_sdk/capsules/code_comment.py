"""YAML capsules embedded in Markdown HTML comments."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import yaml

from .atomic import atomic_write, capsule_lock
from .base import FileCapsule
from .data import CapsuleData, validate_capsule_name
from .errors import DuplicateCapsuleError, MalformedCapsuleError

_BEGIN = re.compile(r"^<!-- flowpad:capsule ([a-z][a-z0-9_-]{0,63})$")
_END = re.compile(r"^flowpad:endcapsule ([a-z][a-z0-9_-]{0,63}) -->$")


class _UniqueSafeLoader(yaml.SafeLoader):
    pass


def _construct_mapping(loader: _UniqueSafeLoader, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
    out: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in out:
            raise DuplicateCapsuleError(f"duplicate YAML key: {key}")
        out[key] = loader.construct_object(value_node, deep=deep)
    return out


_UniqueSafeLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)


@dataclass(frozen=True, slots=True)
class _Block:
    name: str
    start: int
    yaml_start: int
    yaml_end: int
    end: int


def _scan(text: str) -> tuple[_Block, ...]:
    blocks: list[_Block] = []
    active: tuple[str, int, int] | None = None
    offset = 0
    in_fence = False
    for line in text.splitlines(keepends=True):
        logical = line.rstrip("\r\n")
        if logical.lstrip().startswith("```"):
            # A fenced code block is quoted text: a document ABOUT capsules
            # may show the grammar without becoming a capsule itself.
            in_fence = not in_fence
            offset += len(line)
            continue
        if in_fence:
            offset += len(line)
            continue
        begin = _BEGIN.fullmatch(logical)
        end = _END.fullmatch(logical)
        if begin:
            if active is not None:
                raise MalformedCapsuleError("nested capsule block")
            name = validate_capsule_name(begin.group(1))
            active = (name, offset, offset + len(line))
        elif end:
            if active is None:
                raise MalformedCapsuleError("capsule end without a begin marker")
            name, start, yaml_start = active
            if end.group(1) != name:
                raise MalformedCapsuleError("capsule marker names do not match")
            blocks.append(_Block(name, start, yaml_start, offset, offset + len(line)))
            active = None
        elif logical.lstrip().startswith(("<!-- flowpad:capsule", "flowpad:endcapsule")):
            # A line that TRIES to be a marker and fails is corruption; a mere
            # mention of the grammar mid-sentence (docs, plans) is prose.
            raise MalformedCapsuleError("malformed capsule marker")
        offset += len(line)
    if active is not None:
        raise MalformedCapsuleError("unclosed capsule block")
    seen: set[str] = set()
    for block in blocks:
        if block.name in seen:
            raise DuplicateCapsuleError(f"duplicate capsule: {block.name}")
        seen.add(block.name)
    return tuple(blocks)


def _decode(raw: bytes) -> tuple[str, bytes]:
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    try:
        return raw[len(bom):].decode("utf-8"), bom
    except UnicodeDecodeError as exc:
        raise MalformedCapsuleError("capsule files must be UTF-8") from exc


def _newline(text: str) -> str:
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    return "\r\n" if crlf > lf else "\n"


def _yaml_for(data: CapsuleData, newline: str) -> str:
    rendered = yaml.safe_dump(data.to_dict(), allow_unicode=True, sort_keys=False, default_flow_style=False)
    if "-->" in rendered:
        raise MalformedCapsuleError("capsule YAML contains the comment terminator")
    return rendered.replace("\n", newline).rstrip("\r\n") + newline


def _parse(text: str, block: _Block) -> CapsuleData:
    try:
        value = yaml.load(text[block.yaml_start:block.yaml_end], Loader=_UniqueSafeLoader)
    except DuplicateCapsuleError:
        raise
    except yaml.YAMLError as exc:
        raise MalformedCapsuleError(str(exc)) from exc
    if not isinstance(value, dict):
        raise MalformedCapsuleError("capsule YAML root must be an object")
    return CapsuleData.from_dict(value)


def strip_capsule_blocks(text: str) -> str:
    blocks = _scan(text)
    for block in reversed(blocks):
        text = text[:block.start] + text[block.end:]
    return text


def snapshot_capsule_blocks(text: str) -> tuple[str, ...]:
    return tuple(text[block.start:block.end] for block in _scan(text))


def restore_capsule_blocks(text: str, blocks: tuple[str, ...]) -> str:
    text = strip_capsule_blocks(text)
    for raw in blocks:
        _scan(raw)
    if not blocks:
        return text
    newline = _newline(text)
    base = text.rstrip("\r\n")
    return base + (newline * 2 if base else "") + (newline * 2).join(block.rstrip("\r\n") for block in blocks) + newline


class CodeCommentCapsule(FileCapsule):
    def _scan(self, text: str) -> tuple[_Block, ...]:
        return _scan(text)

    def _parse_block(self, text: str, block: _Block) -> CapsuleData:
        return _parse(text, block)

    def _replace(self, name: str, data: CapsuleData, *, only_if_absent: bool) -> CapsuleData:
        validate_capsule_name(name)
        with capsule_lock(self.path):
            text, bom = self._read_text()
            blocks = _scan(text)
            block = next((item for item in blocks if item.name == name), None)
            if block is not None:
                existing = _parse(text, block)
                if only_if_absent or existing == data:
                    return existing
            newline = _newline(text)
            rendered = f"<!-- flowpad:capsule {name}{newline}" + _yaml_for(data, newline) + f"flowpad:endcapsule {name} -->"
            if block is None:
                base = text.rstrip("\r\n")
                updated = base + (newline * 2 if base else "") + rendered + newline
            else:
                suffix = text[block.end:]
                ending = "" if suffix or text[block.start:block.end].endswith(("\n", "\r")) else newline
                updated = text[:block.start] + rendered + ending + suffix
            atomic_write(self.path, bom + updated.encode("utf-8"))
            committed = self.read(name)
            assert committed is not None
            return committed

    def remove(self, name: str) -> bool:
        validate_capsule_name(name)
        with capsule_lock(self.path):
            text, bom = self._read_text()
            block = next((item for item in _scan(text) if item.name == name), None)
            if block is None:
                return False
            updated = text[:block.start] + text[block.end:]
            atomic_write(self.path, bom + updated.encode("utf-8"))
            return True

    def names(self) -> tuple[str, ...]:
        text, _bom = self._read_text()
        blocks = _scan(text)
        for block in blocks:
            _parse(text, block)
        return tuple(sorted(block.name for block in blocks))
