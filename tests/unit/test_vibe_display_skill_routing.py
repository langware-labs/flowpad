"""VIBE-001 contract: the vibe sub-agent makes ``flow show`` the default for handing
something over, so no skill co-loaded in the same flowpad_assistant session may teach
``flow navigate`` as the *only* recipe for opening a file.

The vibe session runs the ``vibe`` agent (``.claude/agents/vibe.md``) and loads
every skill under the same project's ``.claude/skills``. When the user says
"open the existing file ... in the active display", the model matches a
file-opening section of the navigation skills and follows its recipe. If that
recipe is ``flow navigate`` the file opens as a child tab and the process
Display is never updated — exactly the VIBE-001 failure. This is a pure static
contract check over the shipped skill/agent markdown; no worker, no mocks.
"""

from __future__ import annotations

import re
from pathlib import Path

from flow_sdk.config import flowpad_assistant_project_root

# The browser-tab command, reserved for an explicit "take me there".
_NAVIGATE = re.compile(r"\bflow\s+navigate\b")
# The Display/vibe-safe alternative that must accompany any navigate directive.
_SHOW = re.compile(r"\bflow\s+show\b")
# A blanket prohibition — the thing that is actually wrong. Wording-independent, so a
# persona may be reworded freely as long as it does not forbid the verb outright.
_BLANKET_BAN = re.compile(r"(?:never|do\s*not|don'?t)\s+(?:use\s+)?`?flow\s+navigate", re.IGNORECASE)

# A skill section is about opening a file when its heading names a file/opening.
_FILE_OPEN_HEADING = re.compile(r"\bfile\b|\bopen(?:ing)?\b", re.IGNORECASE)


def _sections(markdown: str) -> list[tuple[str, str]]:
    """Split a skill body into (heading, section-text) pairs on ``## `` headings."""
    parts = re.split(r"(?m)^##\s+(.*)$", markdown)
    # parts[0] is the preamble; then alternating heading, body.
    return list(zip(parts[1::2], parts[2::2]))


def _shipped_markdown() -> list[Path]:
    """Every shipped prompt asset: personas AND skills.

    Personas matter as much as skills here — a ``kind: vibe`` persona is embedded
    into the SAME session as ``vibe.md`` (``systemVibeKindSubagentRefs``), so a rule
    in one lands in the same system prompt as the other.
    """
    root = flowpad_assistant_project_root() / ".claude"
    return sorted(root.glob("agents/*.md")) + sorted(root.rglob("skills/**/*.md"))


def test_no_shipped_asset_bans_flow_navigate_outright():
    """``flow navigate`` is reserved, not forbidden.

    The earlier contract asserted the literal string "Never use `flow navigate`" in
    vibe.md. That ban contradicted the flowpad-navigation skill, which reserves the
    verb for an explicit "take me there" — so a vibe session could not honour "take
    me to preferences". Asserting the *absence of a blanket ban* states the real
    invariant and, unlike pinning a replacement sentence, survives rewording.
    """
    offenders = [
        str(path.relative_to(flowpad_assistant_project_root()))
        for path in _shipped_markdown()
        if _BLANKET_BAN.search(path.read_text())
    ]
    assert not offenders, (
        "these shipped assets forbid `flow navigate` outright, contradicting the "
        "flowpad-navigation skill, which reserves it for an explicit 'take me "
        "there':\n  " + "\n  ".join(offenders)
    )


def test_file_open_skills_do_not_route_through_flow_navigate():
    skills_root = flowpad_assistant_project_root() / ".claude" / "skills"
    offenders: list[str] = []
    for skill_md in skills_root.rglob("*.md"):
        for heading, body in _sections(skill_md.read_text()):
            # A file-open section may teach `flow navigate` for the browser-tab
            # case ONLY if it also carves out the vibe/Display case to `flow show`
            # in the same section. A bare `flow navigate` recipe is what makes the
            # model open the file as a child tab instead of the Display (VIBE-001).
            if not _FILE_OPEN_HEADING.search(heading):
                continue
            if _NAVIGATE.search(body) and not _SHOW.search(body):
                rel = skill_md.relative_to(skills_root)
                offenders.append(f"{rel} :: '## {heading.strip()}'")

    assert not offenders, (
        "Vibe sessions load these skills; a file-open section prescribes "
        "`flow navigate` with no `flow show` carve-out for the Display, which "
        "contradicts the vibe display contract (VIBE-001) and opens the file as "
        "a child tab instead of the Display:\n  " + "\n  ".join(offenders)
    )
