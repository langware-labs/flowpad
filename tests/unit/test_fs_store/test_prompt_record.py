"""Unit tests for the PROMPT record recipe (docs/prompt-library.md):
walker, frontmatter parsing (validate-on-adopt ids), gen_id idempotence,
emoji icon round-trip, and the reserved file-only ``queue`` block.
"""
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import read_frontmatter_id
from flow_sdk.fs_store.indexer.functions.prompt import (
    _read_prompt_frontmatter_id,
)
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

V4_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
V7_ID = "0190a0a0-aaaa-7bbb-8ccc-eeeeeeeeeeee"  # foreign version — must be rejected


def _extract(ref: FSRef):
    return SchemaRegistry.get("prompt").from_disk_fn(ref, SchemaRegistry.get("prompt").mint_entity_id(ref))


def _write_md(path: Path, body: str, frontmatter: str | None = None) -> Path:
    text = f"---\n{frontmatter}---\n\n{body}" if frontmatter else body
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_walker_finds_only_prompt_md(tmp_path: Path):
    """Prompt is a REPO asset — the generic ``repo_assets_fn`` discovers it at
    ``agentic-assets/prompt/*.md`` (file-backed leaf, no bespoke walker)."""
    root = tmp_path / "agentic-assets" / "prompt"
    _write_md(root / "a.md", "A")
    _write_md(root / "b.md", "B")
    _write_md(root / "notes.txt", "not md")
    _write_md(tmp_path / "docs" / "c.md", "outside the prompt family")
    refs = repo_assets_fn([FSRef(tmp_path)], IndexerOptions(verbose=False))
    prompts = [r for r in refs if r.record_type == RecordType.PROMPT]
    assert sorted(Path(r.path).name for r in prompts) == ["a.md", "b.md"]


def test_extract_full_frontmatter(tmp_path: Path):
    p = _write_md(
        tmp_path / "prompts" / "review.md",
        "Review the current diff.\n",
        frontmatter=f'id: {V4_ID}\nname: Review my diff\nicon: Search\ncolor: "#7aa2f7"\ngroup_id: {V4_ID}\n',
    )
    [rec] = _extract(FSRef(p))
    assert rec.id == V4_ID
    assert rec.name == "Review my diff"
    assert rec.icon == "Search"
    assert rec.color == "#7aa2f7"
    assert rec.group_id == V4_ID
    assert rec.text == "Review the current diff."
    assert rec.type == RecordType.PROMPT


def test_extract_name_falls_back_to_stem_and_optionals_absent(tmp_path: Path):
    p = _write_md(tmp_path / "prompts" / "quick-fix.md", "Just do it.")
    [rec] = _extract(FSRef(p))
    assert rec.name == "quick-fix"
    assert rec.text == "Just do it."
    assert getattr(rec, "icon", None) is None
    assert getattr(rec, "color", None) is None
    assert getattr(rec, "group_id", None) is None


def test_foreign_version_id_rejected_v4_adopted(tmp_path: Path):
    """Entity-id policy: only v4/v5 frontmatter ids are adopted."""
    p7 = _write_md(tmp_path / "prompts" / "seven.md", "x", frontmatter=f"id: {V7_ID}\n")
    assert _read_prompt_frontmatter_id(p7) is None
    [rec] = _extract(FSRef(p7))
    assert rec.id != V7_ID  # derived uuid5(path) instead

    p4 = _write_md(tmp_path / "prompts" / "four.md", "x", frontmatter=f"id: {V4_ID}\n")
    assert _read_prompt_frontmatter_id(p4) == V4_ID


def test_gen_id_idempotent_and_preserves_fields(tmp_path: Path):
    p = _write_md(
        tmp_path / "prompts" / "keep.md",
        "Body stays.\n",
        frontmatter='name: Keeper\nicon: "🚀"\n',
    )
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    first = SchemaRegistry.get("prompt").mint_entity_id(FSRef(p))
    second = SchemaRegistry.get("prompt").mint_entity_id(FSRef(p))
    assert first == second
    assert _read_prompt_frontmatter_id(p) == first == read_frontmatter_id(p)
    [rec] = _extract(FSRef(p))
    assert rec.name == "Keeper"
    assert rec.icon == "🚀"  # emoji round-trips through yaml quoting
    assert rec.text == "Body stays."


def test_reserved_queue_block_stays_file_only(tmp_path: Path):
    p = _write_md(
        tmp_path / "prompts" / "flagged.md",
        "Run it.",
        frontmatter="name: Flagged\nqueue:\n  clear_first: true\n  ensure_enabled: true\n",
    )
    [rec] = _extract(FSRef(p))
    assert rec.name == "Flagged"
    assert rec.text == "Run it."
    # v1: the queue block is reserved — parsed file stays intact, no record field
    assert getattr(rec, "queue", None) in (None, {})
    assert "clear_first" in p.read_text()


def test_extract_usage_counter_round_trip(tmp_path: Path):
    """use_count / last_used_at survive a reindex (frontmatter → record)."""
    p = _write_md(
        tmp_path / "prompts" / "used.md",
        "Do the thing.",
        frontmatter=f"id: {V4_ID}\nname: Used\nuse_count: 7\nlast_used_at: 2026-06-05T10:00:00Z\n",
    )
    [rec] = _extract(FSRef(p))
    assert rec.use_count == 7
    assert rec.last_used_at == "2026-06-05T10:00:00Z"


def test_extract_usage_counter_defaults_and_junk(tmp_path: Path):
    """Absent counters default to 0; junk values are ignored, not errors."""
    p = _write_md(tmp_path / "prompts" / "fresh.md", "New.", frontmatter="name: Fresh\n")
    [rec] = _extract(FSRef(p))
    assert rec.use_count == 0
    assert getattr(rec, "last_used_at", None) is None

    junk = _write_md(
        tmp_path / "prompts" / "junk.md",
        "x",
        frontmatter="name: Junk\nuse_count: banana\nlast_used_at: 42\n",
    )
    [rec2] = _extract(FSRef(junk))
    assert getattr(rec2, "use_count", None) in (None, 0)
    assert getattr(rec2, "last_used_at", None) is None


def test_default_body_renders_usage_counter(tmp_path: Path):
    """Entity save path (the serializer's render) writes counters extract reads back."""
    from flow_sdk.builtin.prompt import Prompt

    render = SchemaRegistry.get("prompt").serializer().render
    entity = Prompt(name="Counted", text="Count me.", use_count=3, last_used_at="2026-06-05T10:00:00Z")
    body = render(entity)
    p = tmp_path / "prompts" / "counted.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")
    [rec] = _extract(FSRef(p))
    assert rec.use_count == 3
    assert rec.last_used_at == "2026-06-05T10:00:00Z"
    assert rec.text == "Count me."

    fresh = Prompt(name="Fresh", text="New.")
    fresh_body = render(fresh)
    assert "use_count" not in fresh_body  # zero-usage prompts stay minimal
