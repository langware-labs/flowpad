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
3. act only at confidence >= ``MIN_CONFIDENCE``, on a clear lead (``CLEAR_LEAD``), or -- a request that only
   names a thing (``SCOPE``) -- on the place that clearly leads the others (``PLAIN_LEAD``). Below it the answer is ``agentic``: an
   unsure guess opens a confidently wrong screen, which is worse than a slower answer.

Every screen offered is a place on the map, so no answer can name a screen that does not exist.
"""

from __future__ import annotations

import logging
import re
from functools import lru_cache
from typing import Any, Literal, Mapping, Optional

from flow_sdk.core.dock_address import ViewType
from flow_sdk.core.navigation import forms_for, kind, navigation_map, open_form, place_address
from flow_sdk.schema.data_spec.navigator_spec import NavigationTarget, NavigatorRoute

logger = logging.getLogger(__name__)

#: Below this a quick answer is not trusted (benchmark: >= 0.8 was right 99/99; 0.5-0.8 ~58%).
MIN_CONFIDENCE = 0.85
#: ...unless it clearly leads: at least ``CLEAR_LEAD[0]`` and that far ahead of the runner-up. The
#: 0.5-0.85 band is mostly an answer split with a near neighbour or ``agentic``. Measured over 775
#: decisions (four eval runs, 2026-10-07): a 0.3 lead from 0.5 acted on 98 more, every wrong one a
#: request carrying details -- which ``SCOPE`` sends to the assistant before this is asked.
CLEAR_LEAD = (0.5, 0.3)
#: ``(scope "only" at least, best place at least, ahead of the next place by)``. Measured over 1159
#: decisions (eight eval runs, 2026-10-08), every handed-over decision counted: it newly acted on 29,
#: 28 right -- the one wrong, "restart this session", opened the session (naming operations in
#: ``SCOPE`` cost more: it sent listed actions like "reload this page" to the assistant). 0.35 / 0.1
#: also opened "show the diff of this session" (no such screen) -- so not lower.
PLAIN_LEAD = (0.9, 0.4, 0.15)


def _leader(probabilities: Mapping[str, float], at_least: float, ahead_by: float) -> Optional[str]:
    """The top option when it reaches ``at_least`` and leads the runner-up by ``ahead_by``."""
    ranked = sorted(probabilities.items(), key=lambda kp: -kp[1])
    if not ranked or ranked[0][1] < at_least:
        return None
    return ranked[0][0] if len(ranked) < 2 or ranked[0][1] - ranked[1][1] >= ahead_by else None


def _acted_on(result: Any) -> Optional[str]:
    """The ``target`` pick to act on: confident (``MIN_CONFIDENCE``), clearly ahead (``CLEAR_LEAD``),
    or -- when the request is plainly only an open (``SCOPE`` "only") -- the best place, if it clearly
    leads the other places (``PLAIN_LEAD``)."""
    if (key := result.pick("target", min=MIN_CONFIDENCE)) is not None:
        return key
    probabilities = getattr(result.answers.get("target"), "probabilities", None) or {}
    if key := _leader(probabilities, *CLEAR_LEAD):
        return key
    # ``agentic`` in the target means both "not a plain open" and "not listed / ambiguous". When the
    # scope question already says the request only names a thing, the first meaning is answered: a
    # place that clearly leads the other places is the one. Read on the probability of "only" --
    # what PLAIN_LEAD was measured on (the answer's ``confidence`` is the API's calibrated figure,
    # lower: 0.8 for a 0.91).
    only = (getattr(result.answers.get("scope"), "probabilities", None) or {}).get("only", 0.0)
    if only >= PLAIN_LEAD[0]:
        return _leader({k: p for k, p in probabilities.items() if k != "agentic"}, *PLAIN_LEAD[1:])
    return None


#: Full-text candidates offered alongside the screens.
CANDIDATE_LIMIT = 5

# ── the label space ──────────────────────────────────────────────────────────

_SKIP = {"assistant"}  # the assistant is where the request was typed
AGENTIC = (
    "Not a plain open or a listed action: the request needs reasoning, an answer or explanation, writing "
    "or changing content, deleting or restarting something, diagnosis, several steps, or the thing to "
    "open or do is not listed or is ambiguous"
)
INSTRUCTIONS = (
    "The user typed `utterance` into the Flowpad command line while on screen `page`; `context` says what is "
    "current and `candidates` are search matches. Pick the ONE option that does what they asked. Pick `agentic` "
    "unless the request is only to open, show or go to one listed thing, or to do one listed action. A request "
    "that also says what to write or fill in (a title, a message, a time, a rule) is `agentic`: an action "
    "opens an empty form."
)
VERB = {
    "type": "choice",
    "instructions": "Does `utterance` explicitly ask to be taken / to go / to navigate somewhere?",
    "options": {"show": "no: just open or show it (default)", "navigate": "yes: 'take me to', 'go to', 'navigate to'"},
}
#: Asked beside the target, in the same call: a request that carries content or a second step
#: ("create a task to call Dana tomorrow", "open the zoom task and tell me what is left") names a
#: listed form or thing, so the target alone picks it -- this question sends it to the assistant.
SCOPE = {
    "type": "choice",
    "instructions": (
        "Does `utterance` give DETAILS beyond naming one thing to open, show, start, create, add or connect? "
        "Naming the thing is not a detail: 'create a new project', 'add an API key', 'connect a data source', "
        "'schedule a job', 'send a message to Dana' name one thing. Details are what to write or fill in "
        "('a task to call Dana tomorrow', 'every morning at 9'), which account to set up ('connect my gmail'), "
        "a question that needs an answer written for it, or a second step ('... and tell me what is left'). "
        "A question a listed screen shows the answer to ('who is in my org', 'how is Claude funded') is not a detail."
    ),
    "options": {
        "only": "no details: it only names the thing (default)",
        "more": "details: what to write or fill in, a schedule, an account to set up, a question no screen answers, or a second step",
    },
}
#: ``more`` at this confidence hands the request to the assistant whatever the target.
MORE_AT = 0.5


def _static_options() -> tuple[dict[str, str], dict[str, str]]:
    """``{option key: description}`` for every place on the map that needs no pointer, every
    subplace (a screen that needs a pointer still names its fixed ones -- ``tag/graph``), and
    ``{name: key}`` for the rules."""
    options: dict[str, str] = {}
    names: dict[str, str] = {}
    for place in navigation_map().places:
        if place.view in _SKIP:
            continue
        if place.pointer != "required":
            key = f"view:{place_address(place)}"
            aka = ", ".join(place.aliases)
            options[key] = f"Screen '{place.label}'" + (f" (also called: {aka})" if aka else "")
            for name in (place.label, *place.aliases):
                names.setdefault(name.lower(), key)
        for sub in place.subplaces:
            options[f"view:{place_address(place, sub.pointer)}"] = f"Screen '{sub.label}'"
    # A type's name opens its list ("specs", "project manifest") -- where no screen has the name.
    from flow_sdk.core.navigation import asset_list_names  # noqa: PLC0415

    # Never a word that names a screen -- even one that needs a pointer ("help desk" is the
    # project's help desk, not the list of help desks).
    screens = _screen_words()
    assets = next(p for p in navigation_map().places if p.view == ViewType.ASSETS.value)
    for name, pointer in asset_list_names().items():
        if name not in screens:
            names.setdefault(name, f"view:{place_address(assets, pointer)}")
    options.update(_fixed_targets())
    return options, names


def ui_actions() -> dict[str, str]:
    """``{id: what it does}``: the UI actions an answer can be (``action:<id>``) -- a button, a
    dialog, a menu. The UI runs one handler per id (``ui/src/navigation/ui-actions.ts``)."""
    import json  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    return json.loads((Path(__file__).with_name("ui_actions.json")).read_text(encoding="utf-8"))["actions"]


#: Places that are not screens of the dock: the navigator's own log, app pages with an address of
#: their own, and the UI actions.
def _fixed_targets() -> dict[str, str]:
    from flow_sdk.config import FLOWPAD_CLOUD_URL  # noqa: PLC0415

    return {
        "log:smart-navigation": (
            "The smart navigation log: the typed requests with what the navigator decided -- where the records "
            "that need a label are reviewed and labelled"
        ),
        "url:/win/assistant": "Pop the Flowpad Assistant out into a window of its own",
        "url:/discover": "Discover: browse agents, skills and apps to install",
        f"url:{FLOWPAD_CLOUD_URL}": "Flowpad cloud: the hub's website",
        **{f"action:{key}": f"Do it: {what}" for key, what in ui_actions().items()},
    }


@lru_cache(maxsize=1)
def _screen_words() -> frozenset[str]:
    """Every word that names a screen on the map -- its label, aliases and slug."""
    return frozenset(n.lower() for p in navigation_map().places for n in (p.label, *p.aliases, p.view.replace("-", " ")))


@lru_cache(maxsize=1)
def static_options() -> tuple[dict[str, str], dict[str, str]]:
    """``_static_options``, built once per process."""
    return _static_options()


def _entity_options(ref: dict[str, Any], why: str) -> dict[str, str]:
    """What an entity in context (or a search match) can be opened as: itself, and every screen
    that opens on it -- its bare id (``opens``), or a form of it (``open_forms``: a session's
    transcript, a project's dependency graph)."""
    typeid, title = str(ref["typeid"]), ref.get("title") or ""
    kind, _, ident = typeid.partition("-")
    name = f"'{title}'" if title else ""
    noun = kind.replace("_", " ")
    out = {
        f"app:{ident}"
        if kind == "artifact"
        else f"entity:{typeid}": f"{'Launch app' if kind == 'artifact' else 'Open the ' + noun} {name} ({why})"
    }
    # A screen whose address IS the entity's own (a session's screen, a data source's page) is the
    # same place twice: offered once, as the entity -- two keys split one answer's probability
    # until neither clears the bar (measured: 0.81 + 0.12 for one data source).
    from flow_sdk.core.navigation_decision import address_of  # noqa: PLC0415

    own = address_of(NavigationTarget(kind="entity", value=typeid)) if kind != "artifact" else None
    for place in navigation_map().places:
        if kind in place.opens and f"/dock/{place_address(place, ident)}" != own:
            # The aliases are the words a person uses ("transcript" for the Lens): measured,
            # the label alone left "open this session's transcript" under the bar.
            screen = " / ".join((place.label, *place.aliases))
            out[f"view:{place_address(place, ident)}"] = f"{screen} of {noun} {name} ({why})"
    for place, form, what in forms_for(kind):
        if (pointer := open_form(form, ref)) is not None and f"/dock/{place_address(place, pointer)}" != own:
            out[f"view:{place_address(place, pointer)}"] = f"{place.label}: the {what} of {noun} {name} ({why})"
    return out


# ── rules: literals and exact names ──────────────────────────────────────────

_URL = re.compile(r"https?://\S+")
_PATH = re.compile(r"(~?/[\w.\-/ ]*\w\.\w+|~/[\w.\-/]+)")
_PORT = re.compile(r"\bport\s+(\d{2,5})\b", re.I)
_SEARCH = re.compile(r"^(?:search|find)\s+(?:for\s+)?(.+)$", re.I)
_LEAD = re.compile(
    r"^(please\s+)?(open|show( me)?|go to|go|take me to|navigate to|launch|bring up|where are)\s+(the\s+|my\s+)?", re.I
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
    # Exactly a screen's name, of a screen that needs a pointer ("help desk"): never a typo of
    # another word -- the model decides with the context that pointer comes from.
    if len(core) < 6 or core in _screen_words():
        return None
    keys = {key for name, key in names.items() if _slips(core, name) <= TYPO_EDITS}
    return keys.pop() if len(keys) == 1 else None


#: The navigator's own log (SmartNavigationLog): asking for it never needs a model.
SELF_LOG_NAMES = frozenset({"smart navigation log", "navigation log", "smartnavigationlog", "smart navigation data"})


def rule_hit(utterance: str) -> Optional[NavigationTarget]:
    """A literal, or a screen name / alias once the leading verb is stripped -- exact, or a typo of
    exactly one name (live: "open connecitons" went to the model at 0.63 and on to the assistant)."""
    if literal := _literal(utterance):
        return literal
    core = _LEAD.sub("", utterance.strip().rstrip("!?.").lower()).strip()
    if core in SELF_LOG_NAMES:
        return NavigationTarget(kind="log", value="smart-navigation")
    key = _screen_named(core) if core else None
    return NavigationTarget(kind="view", value=key[len("view:") :]) if key else None


#: "this project's connections", "the current session's transcript": a screen of the entity in context.
_POSSESSIVE = re.compile(r"^(?:this|the current|my current|current)\s+(project|session)'?s?\s+(.+)$", re.I)
_SLOT = {"project": ("project", "project"), "session": ("process", "agentic_process")}


def context_rule(utterance: str, here: Any) -> Optional[NavigationTarget]:
    """``this <project|session>'s <name>``: the screen that opens on that entity in context, when
    ``name`` is the opening's name or the screen's name / alias -- exact, no model. None when the
    context lacks the entity or what its address needs."""
    core = _LEAD.sub("", utterance.strip().rstrip("!?.").lower()).strip()
    if not (m := _POSSESSIVE.match(core)) or here is None:
        return None
    slot, kind_name = _SLOT[m.group(1).lower()]
    ref = getattr(here, slot, None)
    if ref is None:
        return None
    wanted = m.group(2).strip()
    found = {
        place_address(place, pointer)
        for place, form, what in forms_for(kind_name)
        if wanted in {what.lower(), place.label.lower(), *(a.lower() for a in place.aliases)}
        and (pointer := open_form(form, ref.model_dump(mode="json", exclude_none=True))) is not None
    }
    return NavigationTarget(kind="view", value=found.pop()) if len(found) == 1 else None


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
    for slot, why in (
        ("project", "current project"),
        ("process", "current session"),
        ("entity", "on screen now"),
        ("recent", "the last chat / session I used"),
    ):
        if ref := getattr(here, slot, None):
            options.update(_entity_options(ref.model_dump(mode="json", exclude_none=True), why))
    # What was shown last ("open it again"): the file or the entity, as it was shown.
    if shown := getattr(here, "last_shown", None):
        if shown.typeid:
            options.update(_entity_options({"typeid": shown.typeid}, "shown last"))
        elif shown.path:
            options[f"file:{shown.path}"] = f"Open the file shown last: {shown.path}"
    for cand in candidates:
        if cand.get("typeid"):
            options.update(_entity_options(cand, "search match"))
        elif cand.get("path"):  # a plain file: opened by its path
            options[f"file:{cand['path']}"] = f"Open the file '{cand.get('title') or cand['path']}' (search match)"
    options["agentic"] = AGENTIC
    return options


# ── the route ────────────────────────────────────────────────────────────────


#: What the parts of the decision's state are, so a reader draws each by its own viewer.
STATE_KINDS = {"context": "navigation.here", "candidates": ["navigator.candidate"]}


def _offered(
    answer: NavigatorRoute,
    candidates: list[dict[str, str]],
    spec: Any = None,
    result: Any = None,
    wire: Any = None,
) -> NavigatorRoute:
    """Keep what was on the table on the answer -- the search matches (``answer.offered``) and the
    model's full input and output (``answer.run``) -- so a caller can record exactly how it was
    decided. Run detail, not part of the answer's shape."""
    from flow_sdk.schema.data_spec.decision_spec import DecisionRun  # noqa: PLC0415
    from flow_sdk.schema.data_spec.navigator_spec import NavigatorRun  # noqa: PLC0415

    answer._offered = list(candidates)
    decision = (
        DecisionRun(
            request=spec,
            response=result,
            act_at={"target": MIN_CONFIDENCE},
            state_kinds=STATE_KINDS,
            # Exactly what went over the wire -- the request body as sent, the response as received.
            wire=wire if wire is not None else getattr(result, "wire", None),
        )
        if spec is not None
        else None
    )
    answer._run = NavigatorRun(reason=answer.reason, decision=decision)
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
        return _offered(NavigatorRoute(route="agentic", reason="empty"), [])
    # Off entirely without a decision API -- the rules included -- so the ask is exactly today's.
    if not await decision_endpoints():
        return _offered(NavigatorRoute(route="agentic", reason="no_endpoint"), [])
    here = kind("navigation.here").model_validate(here or {})
    if hit := rule_hit(utterance) or context_rule(utterance, here):
        return _offered(
            NavigatorRoute(route="quick", target=hit, verb=_verb(utterance), confidence=1.0, reason="rule"), []
        )
    if candidates is None:
        candidates = await _candidates(utterance)
    # An entity is offered as itself and the screens that open on it; a plain file (a path, no
    # typeid) by its path. A match that names neither is nothing to open.
    candidates = [c for c in candidates if c.get("typeid") or c.get("path")]
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
            "scope": SCOPE,
        },
    )
    try:
        result = await decide(spec)
    except DecisionError as exc:
        return _offered(NavigatorRoute(route="agentic", reason=exc.reason), candidates, spec, wire=exc.wire)
    confidence = float(getattr(result.answers.get("target"), "confidence", 0.0))
    more = result.pick("scope", min=MORE_AT) == "more"
    key = None if more else _acted_on(result)
    if key in (None, "agentic"):
        reason = "more" if more else "unsure" if key is None else "agentic"
        answer = NavigatorRoute(route="agentic", reason=reason, confidence=confidence, latency_ms=result.latency_ms)
        return _offered(answer, candidates, spec, result)
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
        spec,
        result,
    )


__all__ = ["MIN_CONFIDENCE", "NavigationTarget", "NavigatorRoute", "options_for", "route", "rule_hit", "static_options"]
