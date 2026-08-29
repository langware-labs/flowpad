"""Anti-drift guard for the language directive in the shipped personas (FLOWPAD-2033).

``tests/unit/test_supported_locales.py`` already pins the BACKEND half of the
contract: ``language_name(None) is None`` — an unset or ``en-US`` locale means
"add no ``# Language`` directive". This file pins the PERSONA half, which is
where the contract was broken.

The regression: ``vibe.md`` / ``standard.md`` carried

    **Language:** Reply in the user's language - every word they see, including the
    short line before a tool call, step headers, and final summaries. Never switch
    to English because these instructions, a skill, or tool output are in English.

On the first turn of an unset-locale project the backend names no language, so
the ONLY standing language instruction was a prohibition on English. The model
duly picked something else. Measured on a 25-run benchmark with a prompt that
carries no language signal at all ("123123"): 7/25 replies were non-English
(3 Spanish, 4 Hebrew). After replacing the prohibition with an explicit
fallback: 0/74 (Fisher p = 3.2e-05).

This has already happened twice — ``fbecc60eb`` removed the block and
``ce3c6d153`` put it back a day later — which is why it is worth a test rather
than a code comment.

The rule these tests encode: **a persona may tell the model to follow the
user's language, but it must never forbid English without naming a fallback.**
"""

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_AGENTS_DIR = _REPO_ROOT / "flow_sdk" / "system_projects" / "flowpad_assistant" / ".claude" / "agents"

# `\s+` between every word on purpose: the original directive wrapped "Never switch\n
# to English" across a newline, and a naive `grep "Never switch to English"` found
# nothing and was briefly taken as evidence the file was clean. A matcher for this
# must not care where the line breaks fall.
_FORBIDS_ENGLISH = re.compile(
    r"(never|don'?t|do\s+not|avoid)\s+(switch(ing)?|revert(ing)?|default(ing)?|fall(ing)?\s+back)"
    r"\s+(to\s+)?english",
    re.IGNORECASE,
)

# A persona that talks about language at all has to say what happens when there
# is nothing to infer from.
_NAMES_A_FALLBACK = re.compile(r"(default|fall\s*back|otherwise|unless|if\s+.{0,40}can'?t)", re.IGNORECASE)

_LANGUAGE_HEADING = re.compile(r"^\*\*Language:\*\*", re.MULTILINE)


def _persona_files() -> list[Path]:
    return sorted(_AGENTS_DIR.glob("*.md"))


def _language_block(text: str) -> str | None:
    """The ``**Language:**`` paragraph, or None if the persona has no such block.

    A block runs from the heading to the next blank line that is followed by a
    new markdown block (another ``**Bold:**`` lead-in or a ``##`` heading), which
    is how these persona files are laid out.
    """
    m = _LANGUAGE_HEADING.search(text)
    if not m:
        return None
    rest = text[m.start():]
    end = re.search(r"\n\s*\n(?=\*\*|#|\Z)", rest)
    return rest[: end.start()] if end else rest


pytestmark = pytest.mark.skipif(
    not _AGENTS_DIR.is_dir(), reason="system_projects/ agents not present (packaged install)"
)


def test_personas_are_discoverable():
    """Guard the guard: if the persona path moves, every test below would pass
    vacuously by iterating an empty list."""
    files = _persona_files()
    assert files, f"no persona .md files found under {_AGENTS_DIR}"
    names = {p.name for p in files}
    assert {"vibe.md", "standard.md"} <= names, f"expected vibe.md and standard.md, found {sorted(names)}"


@pytest.mark.parametrize("path", _persona_files(), ids=lambda p: p.name)
def test_persona_does_not_forbid_english(path: Path):
    """No shipped persona may prohibit English.

    With ``Project.locale`` unset the backend deliberately names no language, so
    a bare prohibition leaves the model with "not English" as its only
    instruction and nothing to choose instead.
    """
    text = path.read_text(encoding="utf-8")
    hit = _FORBIDS_ENGLISH.search(text)
    assert hit is None, (
        f"{path.name} forbids English: {hit.group(0)!r}\n"
        "With an unset/en-US locale the backend adds no `# Language` directive, so this "
        "is the only language instruction the model gets on turn one — and it names no "
        "language to use instead. See FLOWPAD-2033."
    )


@pytest.mark.parametrize("path", _persona_files(), ids=lambda p: p.name)
def test_language_block_names_a_fallback(path: Path):
    """A persona that instructs on language must say what to do when none can be
    inferred. Personas with no ``**Language:**`` block at all are fine."""
    block = _language_block(path.read_text(encoding="utf-8"))
    if block is None:
        pytest.skip(f"{path.name} has no **Language:** block")
    assert "english" in block.lower(), (
        f"{path.name}'s **Language:** block never mentions English, so it does not say "
        f"what to reply in when the user's language cannot be inferred:\n{block}"
    )
    assert _NAMES_A_FALLBACK.search(block), (
        f"{path.name}'s **Language:** block states no fallback (no 'default'/'unless'/"
        f"'otherwise'). An unset-locale first turn has nothing to infer from:\n{block}"
    )


def test_vibe_and_standard_agree():
    """The two chat personas are the same product surface; their language rule
    drifting apart is how one of them keeps the bug after the other is fixed."""
    vibe = _language_block((_AGENTS_DIR / "vibe.md").read_text(encoding="utf-8"))
    standard = _language_block((_AGENTS_DIR / "standard.md").read_text(encoding="utf-8"))
    assert vibe is not None and standard is not None, "both chat personas should carry a language rule"
    assert vibe.split() == standard.split(), (
        "vibe.md and standard.md language rules differ (compared ignoring whitespace):\n"
        f"  vibe    : {vibe}\n"
        f"  standard: {standard}"
    )


def test_detector_catches_the_original_regression():
    """Guard the guard, part two.

    The exact text from ``ce3c6d153``, newline placement included. If a future
    edit loosens ``_FORBIDS_ENGLISH`` until this stops matching, the suite would
    keep passing while the bug walked back in.
    """
    original = (
        "**Language:** Reply in the user's language - every word they see, including the\n"
        "short line before a tool call, step headers, and final summaries. Never switch\n"
        "to English because these instructions, a skill, or tool output are in English.\n"
    )
    assert _FORBIDS_ENGLISH.search(original), "the matcher no longer catches the FLOWPAD-2033 regression"
    assert not _NAMES_A_FALLBACK.search(original.split("summaries.")[-1]), (
        "the original directive stated no fallback; if this trips, the fallback matcher "
        "has become loose enough to accept the buggy text"
    )
