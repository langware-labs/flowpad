"""Minting a virtual entry from its source.

Every handler needs the same three things and gets them wrong in the same three
ways, so they live here once.

**The envelope is copied, not rebuilt.** ``TranscriptEntry.to_dict`` is called
UNBOUND — the base-class function object with the entry passed as ``self`` —
which deliberately skips subclass overrides and yields exactly the base envelope
fields, which are exactly ``__init__``'s kwargs. A new envelope field added to
both therefore rides through derivation with no change here. The pairing is
load-bearing: a key in ``to_dict`` with no matching kwarg is a ``TypeError`` at
derive time, on a parse path.

**Entry ids are suffixed; tool-use ids are NOT.** ``f"{source.id}:{suffix}"``
follows the convention codex's skill handling already shipped, and the registry's
visited set relies on that uniqueness to guarantee a handler fires once per
entry.

``tool_use_id`` is the opposite case and the distinction is easy to get
backwards. It is the *pairing* key: the vendor's tool result carries it, and
``pairToolEvents`` matches on it. A virtual entry that blanked or suffixed it
would pair with nothing and render as permanently in-flight — an unpaired
TOOL_CALL still becomes a pair with ``result: null``, it does not fall through
to the non-tool bucket. So the refinement **inherits** it, and the duplicate is
resolved by the consumer dropping the physical twin (which ``derived_from``
makes exact). Python-side folding is unaffected: ``_fold_tool_results`` runs over
parser output before derivation, so it never sees both.
"""

from __future__ import annotations

from typing import Any

from ..entry import TranscriptEntry


def virtual_envelope(source: TranscriptEntry, suffix: str) -> dict[str, Any]:
    """Constructor kwargs for an entry derived from ``source``.

    Returns the base envelope with a suffixed id, ``virtual=True`` and
    ``derived_from`` pointing back at the source. Callers add their own
    subclass fields on top.
    """
    fields = TranscriptEntry.to_dict(source)
    fields.pop("kind", None)  # a class attribute, not a constructor kwarg
    fields["id"] = f"{source.id}:{suffix}"
    fields["virtual"] = True
    fields["derived_from"] = source.id
    return fields


def shell_fields(source: TranscriptEntry) -> dict[str, Any]:
    """The shell/tool fields a refinement of a command entry carries forward.

    Copied rather than paired for: the outcome (``exit_code``, stdout/stderr)
    is already folded onto the source before derivation runs, so the refinement
    can render a finished command without a tool result of its own.
    ``tool_use_id`` is inherited deliberately — see the module docstring.
    """
    return {
        "command": getattr(source, "command", "") or "",
        "cwd": getattr(source, "cwd", None),
        "exit_code": getattr(source, "exit_code", None),
        "stdout_preview": getattr(source, "stdout_preview", None),
        "stderr_preview": getattr(source, "stderr_preview", None),
        "duration_ms": getattr(source, "duration_ms", None),
        "timeout": getattr(source, "timeout", None),
        "tool_name": getattr(source, "tool_name", "") or "",
        "tool_use_id": getattr(source, "tool_use_id", "") or "",
    }
