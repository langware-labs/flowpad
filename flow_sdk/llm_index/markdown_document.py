"""MarkdownDocument — the one file-level markdown abstraction for this library.

Pure stdlib. A ``MarkdownDocument`` is a single ``.md`` file decomposed into
typed YAML-ish frontmatter + a markdown body, with the few derived accessors
everything here needs: the H1 ``title`` and the ``[[wiki]]`` links in the body.

This is deliberately self-contained — it does NOT reuse flow_sdk's scattered
``_frontmatter`` / ``parse_markdown_text`` helpers, because the whole package is
an independent pure-python library with no coupling to the entity/DB layer.
``FolderNote`` and the index document are thin flavors built on this class.

The frontmatter parser handles the subset this library produces and the common
shapes hand-authored docs use (scalars, quoted strings, and simple lists). It is
lenient: anything it cannot parse is skipped rather than raising.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)
_KV_RE = re.compile(r"^([A-Za-z0-9_\-.]+):\s*(.*)$")
_LIST_ITEM_RE = re.compile(r"^\s*-\s+(.*)$")
_H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
# [[target]] / [[target|alias]] / [[target#h]] / [[target^b]], excluding ![[embed]]
_WIKILINK_RE = re.compile(r"(?<!\!)\[\[([^\]]+?)\]\]")


# ── scalar coercion ───────────────────────────────────────────────────────────


def _unquote(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        inner = s[1:-1]
        if s[0] == '"':
            inner = inner.replace('\\"', '"').replace("\\\\", "\\")
        return inner
    return s


def _coerce(value: str) -> Any:
    v = value.strip()
    if v == "":
        return ""
    low = v.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if re.fullmatch(r"-?\d+", v):
        try:
            return int(v)
        except ValueError:
            return v
    if re.fullmatch(r"-?\d+\.\d+", v):
        try:
            return float(v)
        except ValueError:
            return v
    return v


# ── frontmatter parse / render ────────────────────────────────────────────────


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Split ``text`` into (frontmatter dict, body). No frontmatter → ({}, text)."""
    if not text.startswith("---"):
        return {}, text
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    return _parse_block(m.group(1)), m.group(2)


def _parse_block(block: str) -> dict[str, Any]:
    data: dict[str, Any] = {}
    list_key: str | None = None
    for raw in block.splitlines():
        if not raw.strip():
            continue
        item = _LIST_ITEM_RE.match(raw)
        if item is not None and list_key is not None:
            data[list_key].append(_coerce(_unquote(item.group(1))))
            continue
        kv = _KV_RE.match(raw)
        if kv is None:
            continue
        key, rawval = kv.group(1), kv.group(2).strip()
        if rawval == "":
            data[key] = []           # a block list is expected to follow
            list_key = key
        elif rawval.startswith("[") and rawval.endswith("]"):
            inner = rawval[1:-1]
            data[key] = [_coerce(_unquote(x)) for x in inner.split(",") if x.strip()]
            list_key = None
        else:
            data[key] = _coerce(_unquote(rawval))
            list_key = None
    return data


def _needs_quote(s: str) -> bool:
    return s == "" or any(c in s for c in (":", "#", "\n", '"', "'", "\\", "[", "]"))


def _render_scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    s = "" if value is None else str(value)
    if _needs_quote(s):
        escaped = s.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return s


def render_frontmatter(fields: dict[str, Any]) -> str:
    """Deterministic YAML-ish frontmatter block (insertion-ordered)."""
    lines = ["---"]
    for key, value in fields.items():
        if isinstance(value, list):
            if not value:
                lines.append(f"{key}: []")
            else:
                lines.append(f"{key}:")
                lines.extend(f"  - {_render_scalar(v)}" for v in value)
        else:
            lines.append(f"{key}: {_render_scalar(value)}")
    lines.append("---")
    return "\n".join(lines)


def extract_wiki_links(body: str) -> list[str]:
    """First path segment of each ``[[target]]`` (alias/anchor stripped), de-duped."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in _WIKILINK_RE.findall(body):
        target = raw.split("|", 1)[0].split("#", 1)[0].split("^", 1)[0].strip()
        if target and target not in seen:
            seen.add(target)
            out.append(target)
    return out


# ── the document ──────────────────────────────────────────────────────────────


class MarkdownDocument:
    """A markdown file: typed frontmatter + body, plus title / wiki-links."""

    def __init__(
        self,
        *,
        frontmatter: dict[str, Any] | None = None,
        body: str = "",
        path: Path | str | None = None,
    ):
        self.frontmatter: dict[str, Any] = dict(frontmatter or {})
        self.body: str = body
        self.path: Path | None = Path(path) if path is not None else None

    # -- construction -----------------------------------------------------------

    @classmethod
    def from_text(cls, text: str, *, path: Path | str | None = None) -> "MarkdownDocument":
        fm, body = parse_frontmatter(text)
        return cls(frontmatter=fm, body=body, path=path)

    @classmethod
    def from_path(cls, path: Path | str) -> "MarkdownDocument":
        p = Path(path)
        return cls.from_text(p.read_text(encoding="utf-8", errors="replace"), path=p)

    # -- typed frontmatter access ----------------------------------------------

    def get(self, key: str, default: Any = None) -> Any:
        return self.frontmatter.get(key, default)

    def set(self, key: str, value: Any) -> "MarkdownDocument":
        self.frontmatter[key] = value
        return self

    # -- derived ----------------------------------------------------------------

    @property
    def title(self) -> str:
        m = _H1_RE.search(self.body)
        if m:
            return m.group(1).strip()
        fm_title = self.frontmatter.get("title")
        if fm_title:
            return str(fm_title)
        if self.path is not None:
            return self.path.stem
        return "Untitled"

    @property
    def wiki_links(self) -> list[str]:
        return extract_wiki_links(self.body)

    # -- render / write ---------------------------------------------------------

    def render(self) -> str:
        body = self.body.rstrip("\n")
        if self.frontmatter:
            return render_frontmatter(self.frontmatter) + "\n\n" + body + "\n"
        return body + "\n"

    def save(self, path: Path | str | None = None) -> Path:
        target = Path(path) if path is not None else self.path
        if target is None:
            raise ValueError("MarkdownDocument.save needs a path (none set)")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(self.render(), encoding="utf-8")
        self.path = target
        return target
