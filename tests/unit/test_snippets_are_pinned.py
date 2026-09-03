"""Every ```python fence on the shelf is under a section that names the test running it.

The shelf's rule is that a snippet cannot drift silently. This is the rule's enforcement: a
fence whose section (or whose page preamble) names no existing ``tests/…py`` file fails here,
so the next snippet cannot land unpinned. It checks the NAMING, not the execution — the named
test is where execution is asserted.
"""

from __future__ import annotations

import re

import pytest

from tests.utils.snippets import SHELF

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

REPO = SHELF.parents[1]
_TEST_REF = re.compile(r"`(tests/[\w/.-]+\.py)`")
#: Sections start at H2 and deeper. The H1 is the page title, and what sits under it
#: before the first H2 is the preamble — a "Pinned by" there applies to the whole page.
_HEADING = re.compile(r"^#{2,6}\s", re.MULTILINE)


_FENCE = re.compile(r"```.*?```", re.DOTALL)


def _sections(markdown: str) -> list[str]:
    """The preamble (title + intro), then one chunk per H2+ heading.

    Headings are located on a copy with the fences blanked out (same length, so positions
    hold): a Python comment at column 0 inside a fence is not a heading.
    """
    blanked = _FENCE.sub(lambda m: " " * len(m.group(0)), markdown)
    cuts = [m.start() for m in _HEADING.finditer(blanked)]
    bounds = [0, *cuts, len(markdown)]
    return [markdown[a:b] for a, b in zip(bounds, bounds[1:])]


@pytest.mark.parametrize("page", sorted(p.name for p in SHELF.glob("*.md") if p.name != "README.md"))
def test_every_python_fence_names_its_test(page: str):
    text = (SHELF / page).read_text(encoding="utf-8")
    sections = _sections(text)
    preamble_refs = set(_TEST_REF.findall(sections[0]))
    unpinned: list[str] = []
    for section in sections:
        if "```python" not in section:
            continue
        refs = set(_TEST_REF.findall(section)) | preamble_refs
        if not refs:
            unpinned.append(section.strip().splitlines()[0])
            continue
        missing = [r for r in refs if not (REPO / r).exists()]
        assert not missing, f"{page}: names tests that do not exist: {missing}"
    assert not unpinned, f"{page}: python fences under sections naming no test: {unpinned}"
