"""Routing + trigger contract for the `docit` skill.

docit is an index that routes to `modes/` and `scripts/`, so the failure mode is
a row pointing at a file that moved (dead route) or a file no row mentions
(unreachable). Both are asserted here, in both directions.
"""

import re
from pathlib import Path

from flow_sdk.fs_store.indexer.functions.skill import parse_skill_yaml_from_dir

REPO = Path(__file__).resolve().parents[2]
DOCIT = REPO / ".claude/skills/docit"
SKILL = DOCIT / "SKILL.md"
MIRRORS = (
    REPO / ".agents/skills/docit/SKILL.md",
    REPO / ".github/skills/docit/SKILL.md",
)
GROUND_RULES_MARKER = "Ground rules (inline by design)"


def _backticked(text: str) -> list[str]:
    return re.findall(r"`([^`\n]+)`", text)


def test_every_routing_row_resolves():
    """Forward integrity: each `modes/…` / `scripts/…` reference exists."""
    referenced = [
        token for token in _backticked(SKILL.read_text(encoding="utf-8"))
        if token.startswith(("modes/", "scripts/"))
    ]
    assert referenced, "SKILL.md routes to nothing — it is no longer an index"
    for token in referenced:
        assert (DOCIT / token).exists(), f"dead route in SKILL.md: {token}"
    assert any(not t.endswith("/") for t in referenced), "no file routes at all"


def test_no_unreachable_files():
    """Reverse integrity: every file in the tree is mentioned by the index."""
    source = SKILL.read_text(encoding="utf-8")
    for path in sorted(DOCIT.rglob("*")):
        if not path.is_file() or path == SKILL:
            continue
        rel = path.relative_to(DOCIT).as_posix()
        if rel.startswith(".flow/") or "__pycache__" in rel:
            continue
        assert rel in source, f"orphan file, no row points at it: {rel}"


def test_mode_files_inline_the_same_ground_rules():
    """Cross-cutting rules are repeated in every file they govern, by design —
    so the copies must not drift apart."""
    modes = sorted((DOCIT / "modes").glob("*.md"))
    assert modes, "no mode files"
    blocks = {}
    for mode in modes:
        text = mode.read_text(encoding="utf-8")
        assert GROUND_RULES_MARKER in text, f"{mode.name} lacks the inlined rules"
        # The blockquote runs from the marker to the first non-"> " line.
        start = text.index(GROUND_RULES_MARKER)
        quote = text[text.rindex("\n", 0, start) + 1:]
        blocks[mode.name] = "".join(
            line for line in quote.splitlines(keepends=True)
            if line.startswith(">")
        )
    assert len(set(blocks.values())) == 1, f"ground-rule copies diverged: {list(blocks)}"


def test_description_declares_the_index_subcommands():
    """The sub-commands only trigger if the description names them.

    Read through Flowpad's own loader, not a strict YAML parse: the loader is
    forgiving and on a YAML error keeps only the first line of a multi-line
    scalar, which is how a skill can ship looking fine but route on nothing.
    `description` here is a `>-` block scalar — exactly that shape.
    """
    description = parse_skill_yaml_from_dir(DOCIT).get("description", "")
    for token in ("`docit index`", "`index fast`", "`index full`"):
        assert token in description, f"loader-visible description omits {token}"


def test_referenced_repo_paths_exist():
    """The cross-repo Reference rows point at real machinery."""
    source = SKILL.read_text(encoding="utf-8")
    for token in _backticked(source):
        if token.startswith("flow_sdk/"):
            assert (REPO / token).exists(), f"stale repo path in SKILL.md: {token}"


def test_report_script_reuses_the_library():
    """`fast` formats what LLMIndexer computed; it must not fork the engine."""
    script = (DOCIT / "scripts/docs_index_report.py").read_text(encoding="utf-8")
    assert "from flow_sdk.llm_index import LLMIndexer" in script


def test_mirrors_are_byte_identical():
    """The .agents/ and .github/ copies carry the same SKILL.md bytes.

    Only SKILL.md is mirrored — skill subdirectories are deliberately not copied
    (the SHARED fan-out declared in placement.py is unimplemented), which is why
    SKILL.md names its own canonical location.
    """
    canonical = SKILL.read_bytes()
    for mirror in MIRRORS:
        assert mirror.read_bytes() == canonical, f"mirror desynced: {mirror}"
    assert ".claude/skills/docit/" in canonical.decode("utf-8")
