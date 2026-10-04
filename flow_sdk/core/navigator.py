"""Route a typed request: open something now (a quick action), or hand it to the assistant.

The magic line asks this before starting an assistant turn. The answer is a TARGET the UI
opens through its own navigation (a screen address, an entity, a file, a URL) or ``agentic``
-- and ``agentic`` is also the answer whenever anything is missing or unsure. That is the
contract: **this is an optimisation, never a dependency.** With no decision API on the hub
the navigator is off entirely and every ask behaves exactly as it does without it.

With a decision API, the cascade the benchmark settled on (50 cases x 3 reps, Jev via the
hub: 100% right when it acts, 92% of navigation handled, every reasoning request sent on):

1. **rules** -- a literal URL / path / port / "search for X", or an exact screen name or
   alias from ``VIEW_META``: answered with no model at all;
2. **one decision** -- a ``choice`` over every screen (``VIEW_META``), the request's
   context and full-text candidates, plus ``agentic``;
3. act only at confidence >= ``MIN_CONFIDENCE``. Below it the answer is ``agentic``: an
   unsure guess opens a confidently wrong screen, which is worse than a slower answer.

Every screen offered is a real address (``parse_dock_url``), so no answer can name a
screen that does not exist.
"""

from __future__ import annotations

import logging
import re
from typing import Any, ClassVar, Literal, Optional

from flow_sdk.core.dock_address import VIEW_META, PointerRequirement, parse_dock_url
from flow_sdk.schema.data_spec.spec import DataSpec

logger = logging.getLogger(__name__)

#: Below this a quick answer is not trusted (benchmark: >= 0.8 was right 99/99; 0.5-0.8 ~58%).
MIN_CONFIDENCE = 0.85
#: Full-text candidates offered alongside the screens.
CANDIDATE_LIMIT = 5

Kind = Literal["view", "entity", "file", "url", "webapp", "app"]


class NavigationTarget(DataSpec):
    spec_kind: ClassVar[str] = "navigator.target"

    kind: Kind
    #: A dock address (``credentials/api-keys``, ``hub/token-plan``), a TypeId, a path, a URL,
    #: a port, or an artifact id -- what ``kind`` says.
    value: str


class NavigatorRoute(DataSpec):
    """What to do with a typed request."""

    spec_kind: ClassVar[str] = "navigator.route"

    route: Literal["quick", "agentic"]
    target: Optional[NavigationTarget] = None
    #: ``navigate`` only when the request asked to be TAKEN somewhere; showing is the default.
    verb: Literal["show", "navigate"] = "show"
    confidence: float = 0.0
    #: How it was decided (``rule`` / ``decision``), or why it fell back (``no_endpoint``,
    #: ``unsure``, ``agentic``, a ``DecisionError`` reason).
    reason: str = ""
    latency_ms: float = 0.0


# ── the label space ──────────────────────────────────────────────────────────

# Events has four slugs for one screen; offering all four asks the model to choose between
# identical screens.
_EVENT_TWINS = {"triggers", "signals", "cron"}
_SKIP = {"assistant"}  # the assistant is where the request was typed
SUBVIEWS = {
    "credentials/api-keys": "Credentials > API keys tab",
    "credentials/environment": "Credentials > Environment variables tab",
    "credentials/connections": "Credentials > Connections (OAuth accounts) tab",
    "machine/processes": "Machine > running processes",
    "machine/network": "Machine > network / ports",
    "machine/secrets": "Machine > machine secrets",
    "ai-config/llm-apis": "AI Configuration > LLM APIs tab",
    "ai-config/clis": "AI Configuration > CLIs tab",
    "assets/list/skill": "Assets filtered to skills",
    "assets/list/agent": "Assets filtered to agents",
    "assets/list/prompt": "Assets filtered to prompts",
    "hub/token-plan/me": "Hub token plan > my budget",
    "hub/token-plan/team": "Hub token plan > team budget",
}
#: entity type -> OTHER screens that take that entity's id as their pointer. Only screens that
#: differ from opening the entity itself: offering ``conversation/<id>`` beside the conversation
#: entity is the same destination twice, and the two split the probability until neither clears
#: ``MIN_CONFIDENCE`` (measured: 0.59 / 0.53, both sent to the assistant).
_POINTER_VIEWS = {
    "project": [("graph", "Dependency graph"), ("helpdesk", "Help desk / support portal")],
    "agentic_process": [
        ("lens", "Transcript (Lens)"),
        ("agentic_process", "Process screen"),
        ("diff", "Diff / changes"),
    ],
}
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


def _static_options() -> tuple[dict[str, str], dict[str, str]]:
    """``{option key: description}`` for every addressable screen, and ``{name: key}`` for the rules."""
    options: dict[str, str] = {}
    names: dict[str, str] = {}
    event_aliases: list[str] = []
    for vt, meta in VIEW_META.items():
        slug = vt.value
        if not meta.addressable or meta.pointer == PointerRequirement.REQUIRED or slug in _SKIP:
            continue
        if slug in _EVENT_TWINS or slug == "events":
            event_aliases += [slug, *meta.aliases]
            continue
        key = f"view:hub/{slug}" if meta.pages == ("hub",) else f"view:{slug}"
        aka = ", ".join(meta.aliases)
        options[key] = f"Screen '{meta.label}'" + (f" (also called: {aka})" if aka else "")
        for name in (meta.label, *meta.aliases):
            names.setdefault(name.lower(), key)
    options["view:events"] = "Screen 'Events' (also called: " + ", ".join(dict.fromkeys(event_aliases)) + ")"
    for name in ("events", *event_aliases):
        names.setdefault(name.lower(), "view:events")
    for addr, desc in SUBVIEWS.items():
        if parse_dock_url(f"/dock/{addr}") is not None:
            options[f"view:{addr}"] = f"Screen '{desc}'"
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
    for view, label in _POINTER_VIEWS.get(kind, []):
        if parse_dock_url(f"/dock/{view}/{ident}") is not None:
            out[f"view:{view}/{ident}"] = f"{label} of {noun} {name} ({why})"
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


def rule_hit(utterance: str) -> Optional[NavigationTarget]:
    """A literal, or an exact screen name / alias once the leading verb is stripped."""
    if literal := _literal(utterance):
        return literal
    core = _LEAD.sub("", utterance.strip().rstrip("!?.").lower()).strip()
    key = static_options()[1].get(core)
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


def options_for(utterance: str, context: dict[str, Any], candidates: list[dict[str, str]]) -> dict[str, str]:
    options = dict(static_options()[0])
    for key, why in (
        ("CurrentProjectTypeId", "current project"),
        ("CurrentProcessTypeId", "current session"),
        ("CurrentActiveEntityTypeId", "on screen now"),
    ):
        if typeid := context.get(key):
            title = context.get("active_entity_title", "") if key == "CurrentActiveEntityTypeId" else ""
            options.update(_entity_options(str(typeid), str(title or ""), why))
    for cand in candidates:
        options.update(_entity_options(cand["typeid"], cand.get("title", ""), "search match"))
    options["agentic"] = AGENTIC
    return options


# ── the route ────────────────────────────────────────────────────────────────


async def route(utterance: str, *, page: str = "", context: Optional[dict[str, Any]] = None) -> NavigatorRoute:
    from flow_sdk.decision import DecisionError, DecisionSpec, decide, decision_endpoints  # noqa: PLC0415

    utterance = (utterance or "").strip()
    if not utterance:
        return NavigatorRoute(route="agentic", reason="empty")
    # Off entirely without a decision API -- the rules included -- so the ask is exactly today's.
    if not await decision_endpoints():
        return NavigatorRoute(route="agentic", reason="no_endpoint")
    if hit := rule_hit(utterance):
        return NavigatorRoute(route="quick", target=hit, verb=_verb(utterance), confidence=1.0, reason="rule")

    context = context or {}
    candidates = await _candidates(utterance)
    spec = DecisionSpec(
        state={
            "utterance": utterance,
            "page": page,
            "context": {k: v for k, v in context.items() if v},
            "candidates": candidates,
        },
        questions={
            "target": {
                "type": "choice",
                "instructions": INSTRUCTIONS,
                "options": options_for(utterance, context, candidates),
            },
            "verb": VERB,
        },
    )
    try:
        result = await decide(spec)
    except DecisionError as exc:
        return NavigatorRoute(route="agentic", reason=exc.reason)
    key = result.pick("target", min=MIN_CONFIDENCE)
    answer = result.answers.get("target")
    confidence = float(getattr(answer, "confidence", 0.0))
    if key is None:
        return NavigatorRoute(route="agentic", reason="unsure", confidence=confidence, latency_ms=result.latency_ms)
    if key == "agentic":
        return NavigatorRoute(route="agentic", reason="agentic", confidence=confidence, latency_ms=result.latency_ms)
    verb = result.pick("verb") or "show"
    return NavigatorRoute(
        route="quick",
        target=_target_of(key),
        verb="navigate" if verb == "navigate" else "show",
        confidence=confidence,
        reason="decision",
        latency_ms=result.latency_ms,
    )


__all__ = ["MIN_CONFIDENCE", "NavigationTarget", "NavigatorRoute", "options_for", "route", "rule_hit", "static_options"]
