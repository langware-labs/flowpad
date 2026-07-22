"""YAML capsules embedded in line-comment blocks of source files.

Same capsule grammar and ``{version, data}`` payload as the Markdown carrier
(``code_comment.py``), with every line of the block prefixed by the language's
line-comment leader::

    # flowpad:capsule topic
    # version: 1
    # data:
    #   topics:
    #     flow.runs: "Budget accounting entry points"
    # flowpad:endcapsule topic

The leader + one space is stripped per line before parsing (a bare leader line
denotes an empty YAML line). ``COMMENT_LEADERS`` maps file suffixes to their
leader; ``AssetCapsule.from_path`` dispatches here for those suffixes.
"""
from __future__ import annotations

import re

import yaml

from .atomic import atomic_write, capsule_lock
from .base import FileCapsule
from .code_comment import _UniqueSafeLoader, _decode, _newline
from .data import CapsuleData, validate_capsule_name
from .errors import DuplicateCapsuleError, MalformedCapsuleError

# Suffix → line-comment leader. Deliberately small; extend as needed.
COMMENT_LEADERS: dict[str, str] = {
    ".py": "#",
    ".ts": "//",
    ".tsx": "//",
    ".js": "//",
    ".jsx": "//",
}

_NAME = r"([a-z][a-z0-9_-]{0,63})"


class _Block:
    __slots__ = ("name", "start", "yaml_lines", "end")

    def __init__(self, name: str, start: int, yaml_lines: list[str], end: int):
        self.name = name
        self.start = start
        self.yaml_lines = yaml_lines
        self.end = end


class LineCommentCapsule(FileCapsule):
    def __init__(self, path):
        super().__init__(path)
        leader = COMMENT_LEADERS.get(self.path.suffix.casefold())
        if leader is None:
            raise MalformedCapsuleError(f"no comment leader known for {self.path.suffix!r}")
        self._leader = leader
        escaped = re.escape(leader)
        self._begin = re.compile(rf"^{escaped} flowpad:capsule {_NAME}$")
        self._end = re.compile(rf"^{escaped} flowpad:endcapsule {_NAME}$")

    # ── scanning ────────────────────────────────────────────────────────────

    def _scan(self, text: str) -> tuple[_Block, ...]:
        blocks: list[_Block] = []
        active: tuple[str, int, list[str]] | None = None
        offset = 0
        for line in text.splitlines(keepends=True):
            logical = line.rstrip("\r\n").rstrip()
            begin = self._begin.fullmatch(logical)
            end = self._end.fullmatch(logical)
            if begin:
                if active is not None:
                    raise MalformedCapsuleError("nested capsule block")
                active = (validate_capsule_name(begin.group(1)), offset, [])
            elif end:
                if active is None:
                    raise MalformedCapsuleError("capsule end without a begin marker")
                name, start, yaml_lines = active
                if end.group(1) != name:
                    raise MalformedCapsuleError("capsule marker names do not match")
                blocks.append(_Block(name, start, yaml_lines, offset + len(line)))
                active = None
            elif active is not None:
                stripped = self._strip_leader(logical)
                if stripped is None:
                    raise MalformedCapsuleError("capsule body line without comment leader")
                active[2].append(stripped)
            elif "flowpad:capsule" in logical or "flowpad:endcapsule" in logical:
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

    def _strip_leader(self, logical: str) -> str | None:
        if logical == self._leader:
            return ""
        if logical.startswith(self._leader + " "):
            return logical[len(self._leader) + 1:]
        return None

    @staticmethod
    def _parse(block: _Block) -> CapsuleData:
        try:
            value = yaml.load("\n".join(block.yaml_lines), Loader=_UniqueSafeLoader)
        except DuplicateCapsuleError:
            raise
        except yaml.YAMLError as exc:
            raise MalformedCapsuleError(str(exc)) from exc
        if not isinstance(value, dict):
            raise MalformedCapsuleError("capsule YAML root must be an object")
        return CapsuleData.from_dict(value)

    def _render(self, name: str, data: CapsuleData, newline: str) -> str:
        rendered = yaml.safe_dump(data.to_dict(), allow_unicode=True, sort_keys=False, default_flow_style=False)
        body_lines = [
            (f"{self._leader} {line}" if line else self._leader)
            for line in rendered.rstrip("\n").split("\n")
        ]
        parts = [f"{self._leader} flowpad:capsule {name}", *body_lines, f"{self._leader} flowpad:endcapsule {name}"]
        return newline.join(parts)

    # ── AssetCapsule interface ──────────────────────────────────────────────

    def _read_text(self) -> tuple[str, bytes]:
        try:
            return _decode(self.path.read_bytes())
        except OSError as exc:
            raise MalformedCapsuleError(str(exc)) from exc

    def read(self, name: str) -> CapsuleData | None:
        validate_capsule_name(name)
        text, _bom = self._read_text()
        block = next((item for item in self._scan(text) if item.name == name), None)
        return self._parse(block) if block is not None else None

    def _replace(self, name: str, data: CapsuleData, *, only_if_absent: bool) -> CapsuleData:
        validate_capsule_name(name)
        with capsule_lock(self.path):
            text, bom = self._read_text()
            blocks = self._scan(text)
            block = next((item for item in blocks if item.name == name), None)
            if block is not None:
                existing = self._parse(block)
                if only_if_absent or existing == data:
                    return existing
            newline = _newline(text)
            rendered = self._render(name, data, newline)
            if block is None:
                base = text.rstrip("\r\n")
                updated = base + (newline * 2 if base else "") + rendered + newline
            else:
                updated = text[:block.start] + rendered + newline + text[block.end:]
            atomic_write(self.path, bom + updated.encode("utf-8"))
            committed = self.read(name)
            assert committed is not None
            return committed

    def write(self, name: str, data: CapsuleData) -> CapsuleData:
        return self._replace(name, data, only_if_absent=False)

    def write_if_absent(self, name: str, data: CapsuleData) -> CapsuleData:
        return self._replace(name, data, only_if_absent=True)

    def remove(self, name: str) -> bool:
        validate_capsule_name(name)
        with capsule_lock(self.path):
            text, bom = self._read_text()
            block = next((item for item in self._scan(text) if item.name == name), None)
            if block is None:
                return False
            updated = text[:block.start] + text[block.end:]
            atomic_write(self.path, bom + updated.encode("utf-8"))
            return True

    def names(self) -> tuple[str, ...]:
        text, _bom = self._read_text()
        blocks = self._scan(text)
        for block in blocks:
            self._parse(block)
        return tuple(sorted(block.name for block in blocks))
