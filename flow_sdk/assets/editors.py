"""Which apps edit a thing: the ONE rule, for the UI, an agent and the CLI alike.

An editor is a webapp asset whose ``kind`` is ``application.web.editor``. It edits a subject when:

1. it is NESTED in the subject (``<subject>/agentic-assets/webapp/<name>/``) -- the subject ships
   its own editor; containment is the edge, nothing is declared;
2. its ``edits`` names a kind the subject DECLARES, or an ancestor of it (``navigator`` covers
   ``navigator.dataset``) -- the longer, more specific name ranks first;
3. its ``edits`` names the subject's TYPE (``dataset``) -- the generic editor for every one.

So a dataset that ships no editor still opens in one that knows its kind, else in the generic one.
"""

from __future__ import annotations

from typing import Any, Optional

from flow_sdk.tags.grammar import tag_is_within

EDITOR_KIND = "application.web.editor"


def declared_kind(subject: Any) -> Optional[str]:
    """The kind a subject says it IS -- a dataset's ``spec`` when it names one; else None."""
    spec = getattr(subject, "spec", None)
    return spec if isinstance(spec, str) and spec else None


def rank(app: Any, subject: Any) -> Optional[tuple[int, int]]:
    """``(tier, -specificity)`` when ``app`` edits ``subject``, else None. Lower sorts first."""
    from flow_sdk.tags.grammar import tag_is_within as within  # noqa: PLC0415

    if not within(str(getattr(app, "kind", "") or ""), EDITOR_KIND):
        return None
    if getattr(app, "parent_type_id", None) == str(subject.typeid):
        return (0, 0)
    kind = declared_kind(subject)
    edits = [str(e) for e in (getattr(app, "edits", None) or [])]
    by_kind = [e for e in edits if kind and _covers(e, kind)]
    if by_kind:
        return (1, -max(len(e) for e in by_kind))
    if subject.get_type() in edits:
        return (2, 0)
    return None


def _covers(name: str, kind: str) -> bool:
    try:
        return tag_is_within(kind, name)
    except ValueError:  # a name the tag grammar refuses covers nothing
        return False


async def editors_for(subject: Any) -> list[dict]:
    """The apps that edit ``subject``, best first: ``[{typeid, name, title, why}]``."""
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415

    ranked = []
    for app in await WebApp.get_all({}):
        r = rank(app, subject)
        if r is not None:
            ranked.append((r, app))
    ranked.sort(key=lambda pair: (pair[0], str(pair[1].name)))
    why = {0: "nested", 1: "kind", 2: "type"}
    return [
        {"typeid": str(app.typeid), "name": app.name, "title": getattr(app, "title", "") or app.name, "why": why[r[0]]}
        for r, app in ranked
    ]


__all__ = ["EDITOR_KIND", "declared_kind", "editors_for", "rank"]
