"""Route a typed request: open something now (a quick action), or hand it to the assistant.

The magic line asks this before starting an assistant turn. The answer is a TARGET the UI
opens through its own navigation (a screen address, an entity, a file, a URL) or ``agentic``
-- and ``agentic`` is also the answer whenever anything is missing or unsure. That is the
contract: **this is an optimisation, never a dependency.** With no decision API on the hub
the navigator is off entirely and every ask behaves exactly as it does without it.

With a decision API, the cascade the benchmark settled on (50 cases x 3 reps, Jev via the
hub: 100% right when it acts, 92% of navigation handled, every reasoning request sent on):

1. **rules** -- a literal URL / path / port / "search for X", or an exact screen name or
   alias from the map: answered with no model at all;
2. **one decision** -- a ``choice`` over every screen on the map (``navigation_map``), what is
   in context where the person is (``navigation.here``) and full-text candidates, plus ``agentic``;
3. act only at confidence >= ``MIN_CONFIDENCE``. Below it the answer is ``agentic``: an
   unsure guess opens a confidently wrong screen, which is worse than a slower answer.

Every screen offered is a place on the map, so no answer can name a screen that does not exist.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Literal, Optional

from flow_sdk.core.navigation import kind, navigation_map
from flow_sdk.schema.data_spec.navigator_spec import NavigationTarget, NavigatorRoute

logger = logging.getLogger(__name__)

#: Below this a quick answer is not trusted (benchmark: >= 0.8 was right 99/99; 0.5-0.8 ~58%).
MIN_CONFIDENCE = 0.85
#: Full-text candidates offered alongside the screens.
CANDIDATE_LIMIT = 5

# ── the label space ──────────────────────────────────────────────────────────

_SKIP = {"assistant"}  # the assistant is where the request was typed
AGENTIC = (
    "Not a plain open: the request needs reasoning, an answer or explanation, creating / changing / "
    "sending / deleting / restarting something, setup or connecting, diagnosis, several steps, or the "
    "thing to open is not listed or is ambiguous"
)
INSTRUCTIONS = (
    "The user typed `utterance` into the Flowpad command line while on screen `page`; `context` says what is "
    "current and `candidates` are search matches. Pick the ONE option that does what they asked. Pick `agentic` "
    "unless the request is only to open, show or go to one listed thing."
)
VERB = {
    "type": "choice",
    "instructions": "Does `utterance` explicitly ask to be taken / to go / to navigate somewhere?",
    "options": {"show": "no: just open or show it (default)", "navigate": "yes: 'take me to', 'go to', 'navigate to'"},
}


def _address(place: Any, pointer: str = "") -> str:
    prefix = "hub/" if list(place.pages) == ["hub"] else ""
    return f"{prefix}{place.view}" + (f"/{pointer}" if pointer else "")


def _static_options() -> tuple[dict[str, str], dict[str, str]]:
    """``{option key: description}`` for every place on the map that needs no pointer, its
    subplaces, and ``{name: key}`` for the rules."""
    options: dict[str, str] = {}
    names: dict[str, str] = {}
    for place in navigation_map().places:
        if place.pointer == "required" or place.view in _SKIP:
            continue
        key = f"view:{_address(place)}"
        aka = ", ".join(place.aliases)
        options[key] = f"Screen '{place.label}'" + (f" (also called: {aka})" if aka else "")
        for name in (place.label, *place.aliases):
            names.setdefault(name.lower(), key)
        for sub in place.subplaces:
            options[f"view:{_address(place, sub.pointer)}"] = f"Screen '{sub.label}'"
    return options, names


_STATIC: Optional[tuple[dict[str, str], dict[str, str]]] = None


def static_options() -> tuple[dict[str, str], dict[str, str]]:
    global _STATIC
    if _STATIC is None:
        _STATIC = _static_options()
    return _STATIC


def _entity_options(typeid: str, title: str, why: str) -> dict[str, str]:
    kind, _, ident = typeid.partition("-")
    name = f"'{title}'" if title else ""
    noun = kind.replace("_", " ")
    out = {
        f"app:{ident}"
        if kind == "artifact"
        else f"entity:{typeid}": f"{'Launch app' if kind == 'artifact' else 'Open the ' + noun} {name} ({why})"
    }
    for place in navigation_map().places:
        if kind in place.opens:
            # The aliases are the words a person uses ("transcript" for the Lens): measured,
            # the label alone left "open this session's transcript" under the bar.
            screen = " / ".join((place.label, *place.aliases))
            out[f"view:{_address(place, ident)}"] = f"{screen} of {noun} {name} ({why})"
    return out


# ── rules: literals and exact names ──────────────────────────────────────────

_URL = re.compile(r"https?://\S+")
_PATH = re.compile(r"(~?/[\w.\-/ ]*\w\.\w+|~/[\w.\-/]+)")
_PORT = re.compile(r"\bport\s+(\d{2,5})\b", re.I)
_SEARCH = re.compile(r"^(?:search|find)\s+(?:for\s+)?(.+)$", re.I)
_LEAD = re.compile(
    r"^(please\s+)?(open|show( me)?|go to|take me to|navigate to|launch|bring up|where are)\s+(the\s+|my\s+)?", re.I
)
_NAVIGATE = re.compile(r"^(please\s+)?(go to|take me to|navigate to)\b", re.I)
_STOP = {
    "the",
    "my",
    "a",
    "an",
    "open",
    "show",
    "me",
    "go",
    "to",
    "take",
    "launch",
    "please",
    "this",
    "that",
    "it",
    "of",
    "for",
    "bring",
    "up",
    "navigate",
    "where",
    "are",
    "is",
    "on",
    "in",
    "find",
    "search",
}


def _verb(utterance: str) -> Literal["show", "navigate"]:
    return "navigate" if _NAVIGATE.match(utterance.strip()) else "show"


def _literal(utterance: str) -> Optional[NavigationTarget]:
    text = utterance.strip()
    if m := _URL.search(text):
        return NavigationTarget(kind="url", value=m.group(0))
    if m := _PORT.search(text):
        return NavigationTarget(kind="webapp", value=m.group(1))
    if m := _SEARCH.match(text):
        return NavigationTarget(kind="view", value=f"search?q={m.group(1).strip()}")
    if m := _PATH.search(text):
        return NavigationTarget(kind="file", value=m.group(1).strip())
    return None


#: How far a typed screen name may be from a real one and still open it: one keyboard slip -- a
#: letter missing, extra, wrong, or two swapped ("connecitons" -> connections). Similarity ratios
#: could not tell that from a near-name: "connectors" (Data sources) scored 0.857 beside 0.909.
TYPO_EDITS = 1


def _slips(a: str, b: str) -> int:
    """Edits from ``a`` to ``b`` counting an adjacent swap as one (optimal string alignment)."""
    if abs(len(a) - len(b)) > TYPO_EDITS:
        return TYPO_EDITS + 1
    prev2, prev = None, list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
            if prev2 is not None and i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        prev2, prev = prev, cur
    return prev[-1]


def _screen_named(core: str) -> Optional[str]:
    """The option key ``core`` names: exactly, else as one slip from exactly one screen's name.
    Short words never count as typos -- "tags" is one slip from "tasks"."""
    names = static_options()[1]
    if key := names.get(core):
        return key
    if len(core) < 6:
        return None
    keys = {key for name, key in names.items() if _slips(core, name) <= TYPO_EDITS}
    return keys.pop() if len(keys) == 1 else None


def rule_hit(utterance: str) -> Optional[NavigationTarget]:
    """A literal, or a screen name / alias once the leading verb is stripped -- exact, or a typo of
    exactly one name (live: "open connecitons" went to the model at 0.63 and on to the assistant)."""
    if literal := _literal(utterance):
        return literal
    core = _LEAD.sub("", utterance.strip().rstrip("!?.").lower()).strip()
    key = _screen_named(core) if core else None
    return NavigationTarget(kind="view", value=key[len("view:") :]) if key else None


def _target_of(key: str) -> NavigationTarget:
    kind, _, value = key.partition(":")
    return NavigationTarget(kind=kind, value=value)  # type: ignore[arg-type]


# ── candidates ───────────────────────────────────────────────────────────────


async def _candidates(utterance: str) -> list[dict[str, str]]:
    """Full-text matches for the request's content words (not its verbs)."""
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    words = [w for w in re.findall(r"[\w\-]+", utterance.lower()) if w not in _STOP and len(w) > 1]
    if not words:
        return []
    try:
        found = await Entity.search(query=" ".join(words), limit=CANDIDATE_LIMIT)
    except Exception as exc:  # noqa: BLE001 -- search is a helper; the decision still runs on screens
        logger.warning("navigator: candidate search failed: %s", exc)
        return []
    out = []
    for ent in found:
        kind = ent.type or ent.get_type()
        title = getattr(ent, "_fts_title", None) or getattr(ent, "name", None) or getattr(ent, "title", None) or ""
        out.append({"typeid": f"{kind}-{ent.id}", "type": kind, "title": str(title)})
    return out


def options_for(here: Any, candidates: list[dict[str, str]]) -> dict[str, str]:
    """The map's screens, what ``here`` has in context, the search matches, and ``agentic``."""
    options = dict(static_options()[0])
    for slot, why in (("project", "current project"), ("process", "current session"), ("entity", "on screen now")):
        if ref := getattr(here, slot, None):
            options.update(_entity_options(ref.typeid, ref.title or "", why))
    for cand in candidates:
        options.update(_entity_options(cand["typeid"], cand.get("title", ""), "search match"))
    options["agentic"] = AGENTIC
    return options


# ── the route ────────────────────────────────────────────────────────────────


def _offered(answer: NavigatorRoute, candidates: list[dict[str, str]]) -> NavigatorRoute:
    """Keep the search matches the decision was offered on the answer (``answer.offered``), so a
    caller can record exactly what was on the table. Run detail, not part of the answer's shape."""
    answer._offered = list(candidates)
    return answer


async def route(
    utterance: str,
    *,
    here: Any = None,
    candidates: Optional[list[dict[str, str]]] = None,
) -> NavigatorRoute:
    """``here``: where the person is (a ``navigation.here`` or its dict; ``navigation.here_from``
    builds one from a tab). ``candidates``: the search matches to offer -- searched for when None.
    An eval passes the ones its row recorded, so a run is judged on the same options the row was
    labelled against."""
    from flow_sdk.decision import DecisionError, DecisionSpec, decide, decision_endpoints  # noqa: PLC0415

    utterance = (utterance or "").strip()
    if not utterance:
        return NavigatorRoute(route="agentic", reason="empty")
    # Off entirely without a decision API -- the rules included -- so the ask is exactly today's.
    if not await decision_endpoints():
        return NavigatorRoute(route="agentic", reason="no_endpoint")
    if hit := rule_hit(utterance):
        return NavigatorRoute(route="quick", target=hit, verb=_verb(utterance), confidence=1.0, reason="rule")

    here = kind("navigation.here").model_validate(here or {})
    if candidates is None:
        candidates = await _candidates(utterance)
    spec = DecisionSpec(
        state={
            "utterance": utterance,
            "page": here.address or "",
            "context": here.model_dump(mode="json", exclude_none=True, exclude={"address", "view", "pointer", "page"}),
            "candidates": candidates,
        },
        questions={
            "target": {
                "type": "choice",
                "instructions": INSTRUCTIONS,
                "options": options_for(here, candidates),
            },
            "verb": VERB,
        },
    )
    try:
        result = await decide(spec)
    except DecisionError as exc:
        return _offered(NavigatorRoute(route="agentic", reason=exc.reason), candidates)
    key = result.pick("target", min=MIN_CONFIDENCE)
    answer = result.answers.get("target")
    confidence = float(getattr(answer, "confidence", 0.0))
    if key is None:
        answer = NavigatorRoute(route="agentic", reason="unsure", confidence=confidence, latency_ms=result.latency_ms)
        return _offered(answer, candidates)
    if key == "agentic":
        answer = NavigatorRoute(route="agentic", reason="agentic", confidence=confidence, latency_ms=result.latency_ms)
        return _offered(answer, candidates)
    verb = result.pick("verb") or "show"
    return _offered(
        NavigatorRoute(
            route="quick",
            target=_target_of(key),
            verb="navigate" if verb == "navigate" else "show",
            confidence=confidence,
            reason="decision",
            latency_ms=result.latency_ms,
        ),
        candidates,
    )


__all__ = ["MIN_CONFIDENCE", "NavigationTarget", "NavigatorRoute", "options_for", "route", "rule_hit", "static_options"]
