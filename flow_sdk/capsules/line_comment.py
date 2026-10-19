"""YAML capsules embedded in line-comment blocks of source files.

Same capsule grammar and ``{version, data}`` payload as the Markdown carrier
(``code_comment.py``), with every line of the block prefixed by the language's
line-comment leader::

    # flowpad:capsule tag
    # version: 1
    # data:
    #   tags:
    #     flow.runs: "Budget accounting entry points"
    # flowpad:endcapsule tag

The leader + one space is stripped per line before parsing (a bare leader line
denotes an empty YAML line). ``COMMENT_LEADERS`` maps file suffixes to their
leader; ``AssetCapsule.from_path`` dispatches here for those suffixes.

Repeatable names — the one place a source file differs from a folder or a
Markdown doc. A ``tag`` capsule annotates a *position* (the test or function it
sits above), so one file legitimately carries several; every other name,
notably ``identity``, stays one-per-file and still fails closed on a duplicate.
``_REPEATABLE_NAMES`` is that policy, and it is deliberately per-name rather
than a global relaxation: ``CapsuleIdentityBackend`` depends on duplicate
``identity`` blocks raising.

Positional API for repeatable names (``read``/``write``/``write_if_absent``
keep acting on the FIRST block, so existing single-capsule callers are
unchanged):

* ``read_all(name)``           → every block as ``AnchoredCapsule``
* ``write_at(name, data, line=N)`` → insert immediately above 1-indexed ``N``,
  or replace in place the block of ``name`` already anchored there
"""

from __future__ import annotations

import re
from typing import NamedTuple

import yaml

from .atomic import atomic_write, capsule_lock
from .base import FileCapsule
from .code_comment import _decode, _newline, _UniqueSafeLoader
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

# Names allowed to appear more than once in ONE file. Keep this set tiny and
# never make it global: identity resolution relies on duplicates raising.
_REPEATABLE_NAMES = frozenset({"tag"})


class AnchoredCapsule(NamedTuple):
    """One capsule block with the 1-indexed lines of its two markers."""

    line: int
    end_line: int
    data: CapsuleData


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
            if block.name in _REPEATABLE_NAMES:
                continue
            if block.name in seen:
                raise DuplicateCapsuleError(f"duplicate capsule: {block.name}")
            seen.add(block.name)
        return tuple(blocks)

    def _strip_leader(self, logical: str) -> str | None:
        if logical == self._leader:
            return ""
        if logical.startswith(self._leader + " "):
            return logical[len(self._leader) + 1 :]
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
            (f"{self._leader} {line}" if line else self._leader) for line in rendered.rstrip("\n").split("\n")
        ]
        parts = [f"{self._leader} flowpad:capsule {name}", *body_lines, f"{self._leader} flowpad:endcapsule {name}"]
        return newline.join(parts)

    # ── AssetCapsule interface ──────────────────────────────────────────────

    def _parse_block(self, text: str, block: _Block) -> CapsuleData:
        return self._parse(block)

    @staticmethod
    def _marker_line(text: str, block: _Block) -> int:
        """1-indexed line of the block's begin marker."""
        return text.count("\n", 0, block.start) + 1

    def _anchored(self, text: str, name: str) -> tuple[AnchoredCapsule, ...]:
        out: list[AnchoredCapsule] = []
        for block in self._scan(text):
            if block.name != name:
                continue
            line = self._marker_line(text, block)
            # begin marker + yaml body + end marker
            out.append(AnchoredCapsule(line, line + 1 + len(block.yaml_lines), self._parse(block)))
        return tuple(out)

    def read_all(self, name: str) -> tuple[AnchoredCapsule, ...]:
        """Every block of ``name``, in file order, with its marker lines.

        The positional read for repeatable names — ``read`` only ever sees the
        first block. An absent name returns an empty tuple (not ``None``):
        callers that care about absence check emptiness.
        """
        validate_capsule_name(name)
        text, _bom = self._read_text()
        return self._anchored(text, name)

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
                updated = text[: block.start] + rendered + newline + text[block.end :]
            atomic_write(self.path, bom + updated.encode("utf-8"))
            committed = self.read(name)
            assert committed is not None
            return committed

    def write_at(self, name: str, data: CapsuleData, *, line: int) -> CapsuleData:
        """Place a block of ``name`` immediately above 1-indexed ``line``.

        Insert-or-replace on that ONE position: a block of ``name`` already
        anchored there is rewritten in place, so re-running with an extended
        payload never leaves two blocks stacked on the same anchor. Blocks
        elsewhere in the file are untouched — that is the whole difference from
        ``write``, which acts on the first block wherever it happens to sit.

        Everything else matches the append path: same lock, same atomic
        replacement, same newline/BOM preservation, and an identical payload
        already in place is a no-op that keeps bytes and mtime.

        Raises ``MalformedCapsuleError`` when ``line`` is not a positive int,
        is past the end of the file, or falls inside an existing capsule block
        (splitting one would corrupt every later read).
        """
        validate_capsule_name(name)
        if isinstance(line, bool) or not isinstance(line, int) or line < 1:
            raise MalformedCapsuleError(f"anchor line must be a positive integer, got {line!r}")
        with capsule_lock(self.path):
            text, bom = self._read_text()
            # Validate the whole file before touching bytes — a malformed
            # neighbour must fail here, not leave a half-annotated file.
            blocks = self._scan(text)
            lines = text.splitlines(keepends=True)
            if line > len(lines) + 1:
                raise MalformedCapsuleError(
                    f"anchor line {line} is past the end of {self.path.name} ({len(lines)} lines)"
                )
            offset = sum(len(item) for item in lines[: line - 1])
            for block in blocks:
                if block.start < offset < block.end:
                    raise MalformedCapsuleError(f"anchor line {line} falls inside the {block.name!r} capsule block")
            newline = _newline(text)
            rendered = self._render(name, data, newline) + newline
            # The block belonging to this anchor is either the one already
            # occupying the position (``start == offset`` — the caller passed
            # the line the existing marker sits on) or the one immediately
            # above it (``end == offset`` — the caller passed the annotated
            # line itself). Both readings must replace rather than stack, so a
            # re-run can never leave two blocks on one anchor.
            anchored = next(
                (item for item in blocks if item.name == name and item.start == offset),
                None,
            ) or next(
                (item for item in blocks if item.name == name and item.end == offset),
                None,
            )
            start, end = (anchored.start, anchored.end) if anchored else (offset, offset)
            if text[start:end] == rendered:
                return self._parse(anchored) if anchored else data
            atomic_write(self.path, bom + (text[:start] + rendered + text[end:]).encode("utf-8"))
            # Re-read and locate by byte offset: on the replace path a
            # different block height shifts the anchor, so the committed block
            # is identified by where it starts, not by the requested line.
            committed_text, _bom = self._read_text()
            block = next(
                (item for item in self._scan(committed_text) if item.name == name and item.start == start),
                None,
            )
            assert block is not None
            return self._parse(block)

    def remove(self, name: str) -> bool:
        """Drop EVERY block of ``name`` (a repeatable name may have several)."""
        validate_capsule_name(name)
        with capsule_lock(self.path):
            text, bom = self._read_text()
            blocks = [item for item in self._scan(text) if item.name == name]
            if not blocks:
                return False
            for block in reversed(blocks):  # last first — earlier offsets stay valid
                text = text[: block.start] + text[block.end :]
            atomic_write(self.path, bom + text.encode("utf-8"))
            return True

    def names(self) -> tuple[str, ...]:
        """The DISTINCT names present — a repeatable name appears once here;
        use ``read_all`` for multiplicity."""
        text, _bom = self._read_text()
        blocks = self._scan(text)
        for block in blocks:
            self._parse(block)
        return tuple(sorted({block.name for block in blocks}))
