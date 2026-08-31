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

# The browser-tab command the vibe display contract reserves for an explicit
# "take me there" (vibe.md: "`flow show` is the default ... Reserve `flow navigate`").
_NAVIGATE = re.compile(r"\bflow\s+navigate\b")
# The Display/vibe-safe alternative that must accompany any navigate directive.
_SHOW = re.compile(r"\bflow\s+show\b")
# A skill section is about opening a file when its heading names a file/opening.
_FILE_OPEN_HEADING = re.compile(r"\bfile\b|\bopen(?:ing)?\b", re.IGNORECASE)


def _sections(markdown: str) -> list[tuple[str, str]]:
    """Split a skill body into (heading, section-text) pairs on ``## `` headings."""
    parts = re.split(r"(?m)^##\s+(.*)$", markdown)
    # parts[0] is the preamble; then alternating heading, body.
    return list(zip(parts[1::2], parts[2::2]))


def _vibe_defaults_to_show() -> bool:
    """vibe.md must state ``flow show`` as the default for handing work over.

    This used to assert the blanket string "Never use `flow navigate`". That ban
    contradicted the flowpad-navigation skill, which (correctly) reserves
    ``flow navigate`` for an explicit "take me there" — so a vibe session could not
    honour "take me to preferences". The premise the scan below actually needs is
    the weaker, true one: show is the DEFAULT, navigate is the narrow exception.
    """
    agent = flowpad_assistant_project_root() / ".claude" / "agents" / "vibe.md"
    text = agent.read_text()
    return "`flow show` is the default" in text and "Reserve `flow navigate`" in text


def test_file_open_skills_do_not_route_through_flow_navigate():
    # Premise guard: the contract only holds because vibe.md defaults to `flow show`.
    assert _vibe_defaults_to_show(), (
        "vibe.md no longer states `flow show` as the default with `flow navigate` "
        "reserved for an explicit 'take me there'"
    )

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
