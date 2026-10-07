"""Which apps edit a thing: the ONE rule, for the UI, an agent and the CLI alike.

An editor is a webapp asset whose ``kind`` is ``application.web.editor``. It edits a subject when:

1. it is NESTED in the subject (``<subject>/agentic-assets/webapp/<name>/``) -- the subject ships
   its own editor; containment is the edge, nothing is declared;
2. its ``edits`` names a kind the subject DECLARES, or an ancestor of it (``navigator`` covers
   ``navigator.dataset``) -- the longer, more specific name ranks first;
3. its ``edits`` names the subject's TYPE (``dataset``) -- the generic editor for every one.

So a dataset that ships no editor still opens in one that knows its kind, else in the generic one.

A VIEWER (``application.web.viewer``) is ranked by the same rule for a VALUE of a kind rather than an
entity (:func:`viewers_for`): nested in the asset being shown, then the most specific kind its
``views`` names (by the ontology), then ``*`` -- the generic viewer. A viewer says per kind whether it
shows a ``single`` value, a ``collection``, or both. An app whose folder is gone is never offered.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from flow_sdk.builtin.faas.webapp_spec import EDITOR_KIND, VIEWER_KIND
from flow_sdk.worldview.ontology import kind_matches

_WHY = {0: "nested", 1: "kind", 2: "type"}
_VIEW_WHY = {0: "nested", 1: "kind", 2: "any"}
#: The kind a viewer declares to show ANY kind -- the generic one, ranked last.
ANY_KIND = "*"


def _declared_kind(subject: Any) -> Optional[str]:
    """The kind a subject says it IS -- a dataset's ``spec`` when it names one; else None."""
    spec = getattr(subject, "spec", None)
    return spec if isinstance(spec, str) and spec else None


def rank(app: Any, subject: Any) -> Optional[tuple[int, int]]:
    """``(tier, -specificity)`` when ``app`` edits ``subject``, else None. Lower sorts first."""
    if not kind_matches(EDITOR_KIND, str(getattr(app, "kind", "") or "")):
        return None
    if getattr(app, "parent_type_id", None) == str(subject.typeid):
        return (0, 0)
    edits = [str(e) for e in (getattr(app, "edits", None) or [])]
    if best := _best_kind(edits, _declared_kind(subject)):
        return (1, -len(best))
    if subject.get_type() in edits:
        return (2, 0)
    return None


def _best_kind(declared: list[str], kind: Optional[str]) -> Optional[str]:
    """The most specific declared kind covering ``kind`` by the ontology (the longest), else None."""
    return max((d for d in declared if kind and d != ANY_KIND and kind_matches(d, kind)), key=len, default=None)


def _on_disk(app: Any) -> bool:
    """A file-backed app whose folder is gone is a stale row -- never offered (it would 404)."""
    return not app.is_file_backed() or Path(app.asset_ref).is_dir()


def view_rank(app: Any, kind: str, shape: str, within: Optional[str] = None) -> Optional[tuple[tuple[int, int], str]]:
    """``((tier, -specificity), the declared kind that matched)`` when ``app`` shows ``kind`` as
    ``shape``, else None. Tier 0: nested in ``within``; 1: a declared kind covers it; 2: ``*``."""
    if not kind_matches(VIEWER_KIND, str(getattr(app, "kind", "") or "")):
        return None
    declared = [str(_get(v, "kind", "")) for v in (getattr(app, "views", None) or []) if shape in _get(v, "shows", ["single"])]
    best = _best_kind(declared, kind) or (ANY_KIND if ANY_KIND in declared else None)
    if best is None:
        return None
    specificity = 0 if best == ANY_KIND else -len(best)
    if within and getattr(app, "parent_type_id", None) == within:
        tier = 0
    else:
        tier = 2 if best == ANY_KIND else 1
    return (tier, specificity), best


def _get(value: Any, key: str, default: Any) -> Any:
    return value.get(key, default) if isinstance(value, dict) else getattr(value, key, default)


async def editors_for(subject: Any) -> list[dict]:
    """The apps that edit ``subject``, best first: ``[{typeid, name, title, why}]``."""
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415

    ranked = sorted(
        # Scoped to editor apps: an editor declares exactly ``EDITOR_KIND`` (``rank`` still checks it).
        (
            (r, app)
            for app in await WebApp.get_all({"kind": EDITOR_KIND})
            if (r := rank(app, subject)) is not None and _on_disk(app)
        ),
        key=lambda pair: (pair[0], str(pair[1].name)),
    )
    return [
        {"typeid": str(app.typeid), "name": app.name, "title": getattr(app, "title", "") or app.name, "why": _WHY[r[0]]}
        for r, app in ranked
    ]


async def viewers_for(kind: str, shape: str = "single", within: Optional[str] = None) -> list[dict]:
    """The viewers that show a value (``single``) or a list (``collection``) of ``kind``, best first:
    ``[{typeid, name, title, why, kind, endpoint, module}]``. ``within`` is the typeid of the asset
    being shown -- a viewer nested in it wins. ``kind`` is the declared kind that matched (the key of
    the module's ``viewers``); ``module`` is the file inside the ``endpoint`` that serves the app (the
    SDK makes the address). A viewer not placed on this machine is skipped."""
    from flow_sdk.builtin.faas.micro_app import WebApp  # noqa: PLC0415
    from flow_sdk.builtin.webapp_placement import webapp_endpoints  # noqa: PLC0415
    ranked = sorted(
        (
            (r, app)
            for app in await WebApp.get_all({"kind": VIEWER_KIND})
            if (r := view_rank(app, kind, shape, within)) is not None and _on_disk(app)
        ),
        key=lambda pair: (pair[0][0], str(pair[1].name)),
    )
    out = []
    for (order, declared), app in ranked:
        served = [e for e in await webapp_endpoints(str(app.id)) if getattr(e.backend, "type", "") == "static"]
        if not served:
            continue
        out.append({
            "typeid": str(app.typeid),
            "name": app.name,
            "title": getattr(app, "title", "") or app.name,
            "why": _VIEW_WHY[order[0]],
            "kind": declared,
            "endpoint": str(served[0].id),
            "module": str(getattr(app, "module", "") or "viewer.js").lstrip("/"),
        })
    return out


__all__ = ["editors_for", "rank", "viewers_for"]
