"""What a person wrote when they asked for a diagnosis: did they describe a problem at all?

A report of ``hi9`` or ``test`` is a test message, not a symptom. A diagnosis given only that has
nothing to look into, so it sweeps every log and reports whatever stands out, which reads as the
cause of the report (an old, unrelated crash headlines a ticket that said nothing). Naming the case
lets the diagnosis say so instead.
"""

from __future__ import annotations

import re

#: Fewer words than this is not a description of a problem ("hi9", "test", "help").
MIN_DESCRIPTION_WORDS = 2

_WORD = re.compile(r"\w+", re.UNICODE)


def describes_a_problem(text: str | None) -> bool:
    """True when ``text`` is more than one word: a pasted error, or a sentence about what went wrong."""
    return len(_WORD.findall(text or "")) >= MIN_DESCRIPTION_WORDS


def no_description_instruction(text: str | None) -> str:
    """What the diagnosing agent is told when the person described nothing (empty when they did)."""
    if describes_a_problem(text):
        return ""
    wrote = (text or "").strip()
    given = f'They wrote only "{wrote}".' if wrote else "They wrote nothing."
    return (
        f"The person gave NO description of a problem. {given} Follow the skill's section "
        '"When no problem was described": say so in the title and the summary, report what is wrong '
        "NOW, and list anything older apart, marked as unrelated to their report."
    )
