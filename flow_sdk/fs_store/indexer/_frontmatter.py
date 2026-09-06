"""Shared YAML frontmatter utilities for markdown-based records (skills, agents)."""

from __future__ import annotations

import logging
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def _asset_path(ref: Any) -> Path:
    return Path(getattr(ref, "_path", ref))


def _coerce_scalar(value: str) -> Any:
    raw = value.strip()
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        return raw[1:-1]
    if raw.startswith("'") and raw.endswith("'") and len(raw) >= 2:
        return raw[1:-1]
    low = raw.lower()
    if low in {"true", "false"}:
        return low == "true"
    if low in {"null", "none", "~"}:
        return None
    if re.fullmatch(r"-?\d+", raw):
        try:
            return int(raw)
        except ValueError:
            return raw
    if re.fullmatch(r"-?\d+\.\d+", raw):
        try:
            return float(raw)
        except ValueError:
            return raw
    return raw


def _parse_simple_yaml_map(text: str) -> dict[str, Any]:
    """Parse a small YAML mapping subset for environments without PyYAML."""
    data: dict[str, Any] = {}
    lines = text.splitlines()
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        i += 1
        if not stripped or stripped.startswith("#") or ":" not in line:
            continue

        key, raw_value = line.split(":", 1)
        key = key.strip()
        value = raw_value.strip()

        if value in {">", "|"}:
            block: list[str] = []
            while i < len(lines):
                next_line = lines[i]
                if re.match(r"^[A-Za-z_][A-Za-z0-9_-]*\s*:", next_line):
                    break
                if next_line.startswith("  "):
                    block.append(next_line[2:])
                    i += 1
                    continue
                if next_line.strip() == "":
                    block.append("")
                    i += 1
                    continue
                break
            block_text = "\n".join(block).strip()
            if value == ">":
                block_text = " ".join(part.strip() for part in block_text.splitlines() if part.strip())
            data[key] = block_text
            continue

        # Handle YAML lists (simple inline)
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            if not inner:
                data[key] = []
            else:
                data[key] = [_coerce_scalar(item) for item in inner.split(",")]
            continue

        data[key] = _coerce_scalar(value)

    return data


def _yaml_load(text: str) -> dict[str, Any]:
    try:
        import yaml  # type: ignore

        parsed = yaml.safe_load(text)
        if isinstance(parsed, dict):
            return parsed
    except Exception as e:
        # Say something. The fallback reader below is line-based, so malformed
        # YAML degrades to a PARTIAL dict rather than an error — a skill whose
        # `description:` spans lines silently loses it and stops being routable,
        # with nothing in the logs to explain why. One unquoted colon has
        # already shipped that way twice.
        logger.warning("frontmatter YAML did not parse (%s); falling back to the line reader", e)
    return _parse_simple_yaml_map(text)


def _extract_frontmatter(text: str) -> str | None:
    """Return the YAML text between opening and closing ``---`` delimiters."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i]).strip()
    return None


def _extract_body(text: str) -> str:
    """Return the markdown body after the closing ``---`` frontmatter delimiter."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[i + 1:]).strip()
    return text


def carry_capsules(rendered: str, existing: str) -> str:
    """``rendered`` with the capsule blocks of ``existing`` re-attached — every
    non-identity capsule (a ``tag`` block another skill wrote) survives a save.
    The ``identity`` block is carried only while ``rendered`` has no
    frontmatter ``id``: once the id is in the header the block is legacy."""
    from flow_sdk.capsules import restore_capsule_blocks, snapshot_capsule_blocks  # noqa: PLC0415

    header = _extract_frontmatter(rendered)
    has_id = bool(header) and "id" in (_yaml_load(header) or {})
    blocks = snapshot_capsule_blocks(existing)
    if has_id:
        blocks = tuple(b for b in blocks if not b.lstrip().startswith("<!-- flowpad:capsule identity"))
    return restore_capsule_blocks(rendered, blocks)


def merge_frontmatter(
    text: str,
    updates: dict[str, Any],
    *,
    drop_keys: tuple[str, ...] = (),
    prepend: bool = False,
) -> str:
    """Merge ``updates`` into a file's frontmatter, preserving body + other keys.

    Returns the full new file text (``---`` block + blank line + body). The body
    is re-attached verbatim, so unrelated content is never disturbed. ``drop_keys``
    removes keys from the existing frontmatter before merging (e.g. legacy
    ``asset_id``). ``prepend=True`` places ``updates`` first in key order (used when
    minting ``id`` so it stays at the top); otherwise existing key order is kept and
    ``updates`` overwrite in place / append new keys at the end.
    """
    fm = _extract_frontmatter(text)
    body = _extract_body(text)
    fields: dict[str, Any] = {}
    if fm:
        parsed = _yaml_load(fm)
        if isinstance(parsed, dict):
            fields.update(parsed)
    for k in drop_keys:
        fields.pop(k, None)
    if prepend:
        merged = {**updates, **{k: v for k, v in fields.items() if k not in updates}}
    else:
        merged = dict(fields)
        merged.update(updates)
    tail = "\n" if body and not body.endswith("\n") else ""
    return _render_frontmatter(merged) + "\n\n" + body + tail


def read_frontmatter_id(
    path: Any,
    *,
    keys: tuple[str, ...] = ("id", "asset_id"),
) -> str | None:
    """Purely read the first valid v4/v5 id from frontmatter.

    ``keys`` is the type-owned precedence list. Invalid candidates are ignored
    so a valid legacy field remains backward-compatible. The file is never
    rewritten or backfilled by extraction.
    """
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415

    path = _asset_path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    frontmatter = _extract_frontmatter(text)
    if not frontmatter:
        return None
    fields = _yaml_load(frontmatter) or {}
    for key in keys:
        adopted = adopt_entity_id(fields.get(key))
        if adopted is not None:
            return adopted
    return None


def _atomic_write_text(path: Path, text: str) -> None:
    """Atomically replace ``path`` with UTF-8 ``text``, preserving its mode."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.read_text(encoding="utf-8") == text:
            return
    except OSError:
        pass

    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
        except OSError:
            pass
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def write_frontmatter_id(path: Any, entity_id: str) -> bool:
    """Force ``entity_id`` into a file's frontmatter ``id:`` — returns whether it
    persisted. Preserves the body and every existing field, including legacy id
    fields: writing identity is not a cleanup or migration operation."""
    from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415

    path = _asset_path(path)
    adopted = adopt_entity_id(entity_id)
    if adopted is None:
        return False
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        text = ""
    try:
        _atomic_write_text(path, merge_frontmatter(text, {"id": adopted}, prepend=True))
        return True
    except OSError:
        return False


def _plain_yaml(value: Any) -> Any:
    """Recurse a value down to plain YAML-representable Python.

    Lives here rather than in one type's ``default_body_fn`` so every
    folder-asset type is covered, not just the first one to hit the problem.
    """
    if isinstance(value, dict):
        return {str(k): _plain_yaml(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_yaml(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _render_frontmatter(fields: dict[str, Any]) -> str:
    """Serialize a dict to a ``---\\n...\\n---`` YAML frontmatter block."""
    try:
        import yaml  # type: ignore

        # safe_dump over coerced values. Entity fields arrive as TrackedList /
        # TrackedDict (mutation-tracking collections holding a `_parent` backref
        # to the entity) and as TypeId. Plain `yaml.dump` happily emitted
        # `!!python/object/new:` for those and, following `_parent`, serialized
        # the ENTIRE entity into the frontmatter — one UI field edit once turned
        # a 26-line agent.md into 190 lines of pickled object graph carrying
        # absolute paths. safe_dump makes an un-coerced exotic type raise (and
        # fall to the simple renderer below) instead of pickling itself.
        yaml_text = yaml.safe_dump(
            _plain_yaml(fields), default_flow_style=False, sort_keys=False, allow_unicode=True
        ).strip()
    except Exception:
        # Fallback: simple key: value rendering
        parts: list[str] = []
        for k, v in fields.items():
            if isinstance(v, list):
                parts.append(f"{k}: [{', '.join(str(x) for x in v)}]")
            elif isinstance(v, bool):
                parts.append(f"{k}: {'true' if v else 'false'}")
            elif v is None:
                continue
            else:
                parts.append(f"{k}: {v}")
        yaml_text = "\n".join(parts)
    return f"---\n{yaml_text}\n---"
