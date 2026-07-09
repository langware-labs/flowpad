"""Shared YAML frontmatter utilities for markdown-based records (skills, agents)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


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
    except Exception:
        pass
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


def adopt_or_mint_id(
    path: Path,
    *,
    write_back: bool = True,
    derive_key: str | None = None,
) -> str:
    """Resolve a file-backed entity's id from its frontmatter capsule.

    The universal miss-policy for shareable file entities: adopt a valid v4/v5 id
    from the file's frontmatter (the capsule) if present; otherwise **mint a random
    v4 and write it into the frontmatter** so a re-index adopts it. Deriving
    ``uuid5(path)`` is NOT the miss behavior — it survives only as the read-only
    fallback (``derive_key``) for a file we cannot write, so repeated scans of an
    un-writable file stay idempotent.

    - ``write_back`` — ``True`` on the gen path (mint + persist); ``False`` for cheap
      read-only peeks (never touches disk; returns the derived value on a miss).
    - ``derive_key`` — overrides the read-only/miss fallback seed; when omitted it
      defaults to ``str(path.resolve())`` (computed lazily, only when the fallback
      is actually reached, so the common stamped path pays no ``resolve()`` syscall).
    """
    from flow_sdk.fs_store.identifier import adopt_entity_id, mint_uuid  # noqa: PLC0415

    # Single read: the frontmatter id AND (on the write path) the body to merge.
    try:
        text: str | None = path.read_text(encoding="utf-8")
    except OSError:
        text = None
    raw_id = None
    if text is not None:
        fm = _extract_frontmatter(text)
        if fm:
            fields = _yaml_load(fm) or {}
            raw_id = fields.get("id") or fields.get("asset_id")
    adopted = adopt_entity_id(raw_id)
    if adopted:
        return adopted

    def _fallback() -> str:
        # Stable uuid5 — the ONLY surviving derive, reached only for a read-only
        # file (or a peek on a not-yet-stamped one).
        return mint_uuid(derive_key or str(path.resolve()))

    if not write_back:
        return _fallback()

    new_id = mint_uuid()  # no key → uuid4
    try:
        path.write_text(
            merge_frontmatter(text or "", {"id": new_id}, drop_keys=("asset_id",), prepend=True),
            encoding="utf-8",
        )
    except OSError:
        return _fallback()  # read-only file: can't persist a v4
    return new_id


def _render_frontmatter(fields: dict[str, Any]) -> str:
    """Serialize a dict to a ``---\\n...\\n---`` YAML frontmatter block."""
    try:
        import yaml  # type: ignore

        yaml_text = yaml.dump(fields, default_flow_style=False, sort_keys=False, allow_unicode=True).strip()
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
