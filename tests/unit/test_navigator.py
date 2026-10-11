"""The navigator: open something now, or hand the request to the assistant.

``decide`` and the endpoint listing are doubled; what is under test is the cascade and its
contract -- off without a decision API, rules before the model, a confident answer opens,
anything else is ``agentic``. The live numbers (50 cases x 3 through ``route()``, Jev via the
local hub: 100% precision, 92% coverage, 0 confident-wrong, P95 329 ms) are the benchmark's.
"""

from __future__ import annotations

import pytest

import flow_sdk.decision as decision
from flow_sdk.core import navigation, navigator
from flow_sdk.core.dock_address import parse_dock_url
from flow_sdk.external_apis.decision import DecisionError
from flow_sdk.schema.data_spec.api_endpoint_spec import APIEndpointOffer
from flow_sdk.schema.data_spec.decision_spec import ChoiceAnswer, DecisionResult

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

JEV = APIEndpointOffer(
    id="72575461-9352-4cdb-b2e7-a53be3e3d6e3", name="Jev", kinds=["decision"], host="api.typesafe.ai"
)
TASK = "task-8b3c4d5e-6f7a-4b2c-8d3e-4f5a6b7c8d9e"


@pytest.fixture
def hub(monkeypatch):
    """A decision API exists; ``decide`` answers ``state['answer']``; records every spec it got."""
    state = {"endpoints": [JEV], "answer": None, "error": None, "specs": []}

    async def _endpoints(**kwargs):
        return state["endpoints"]

    async def _decide(spec, *, endpoint=None):
        state["specs"].append(spec)
        if state["error"]:
            raise state["error"]
        key, conf, verb = state["answer"]
        return DecisionResult(
            answers={
                "target": ChoiceAnswer(choice=key, confidence=conf),
                "verb": ChoiceAnswer(choice=verb, confidence=0.99),
            }
        )

    async def _candidates(utterance):
        return [{"typeid": TASK, "type": "task", "title": "Zoom OAuth on dev"}]

    monkeypatch.setattr(decision, "decision_endpoints", _endpoints)
    monkeypatch.setattr(decision, "decide", _decide)
    monkeypatch.setattr(navigator, "_candidates", _candidates)
    return state


async def test_without_a_decision_api_every_ask_is_todays_even_an_exact_screen_name(hub):
    hub["endpoints"] = []
    r = await navigator.route("data sources")
    assert (r.route, r.reason) == ("agentic", "no_endpoint") and hub["specs"] == []


@pytest.mark.parametrize(
    ("utterance", "kind", "value", "verb"),
    [
        ("open data sources", "view", "data-sources", "show"),
        ("connections", "view", "credentials", "show"),  # an alias, not the slug it resembles
        ("take me to preferences", "view", "preferences", "navigate"),
        ("open https://linear.app", "url", "https://linear.app", "show"),
        ("open the app on port 5173", "webapp", "5173", "show"),
        ("open localhost:5173", "webapp", "5173", "show"),  # a port named as an address (stress run)
        ("search for widget", "view", "search?q=widget", "show"),
        ("open ~/notes/plan.md", "file", "~/notes/plan.md", "show"),
        ("open connecitons", "view", "credentials", "show"),  # a typo of one name (logged live)
        ("show me prefrences", "view", "preferences", "show"),
    ],
)
async def test_a_rule_answers_before_the_model(hub, utterance, kind, value, verb):
    r = await navigator.route(utterance)
    assert (r.route, r.target.kind, r.target.value, r.verb, r.reason) == ("quick", kind, value, verb, "rule")
    assert hub["specs"] == [], "a rule hit never spends a decision"
    assert (r.run.reason, r.run.decision) == ("rule", None), "a rule: no model was asked"


async def test_a_confident_decision_opens_it(hub):
    hub["answer"] = (f"entity:{TASK}", 0.97, "show")
    r = await navigator.route("open the zoom oauth task", here={"view": "home", "address": "/dock/home"})
    assert (r.route, r.target.kind, r.target.value, r.reason) == ("quick", "entity", TASK, "decision")
    spec = hub["specs"][0]
    assert spec.state["utterance"] == "open the zoom oauth task" and spec.state["candidates"][0]["typeid"] == TASK
    assert spec.state["page"] == "/dock/home"
    assert "agentic" in spec.questions["target"].options and f"entity:{TASK}" in spec.questions["target"].options
    # How it was decided travels with the answer: the very spec sent, the answer received, the bar.
    run = r.run.decision
    assert run.request is spec and run.response.answers["target"].choice == f"entity:{TASK}"
    assert run.act_at == {"target": navigator.MIN_CONFIDENCE}, "the bar the pick had to clear, per question"


@pytest.mark.parametrize(
    ("answer", "error", "reason"),
    [
        ((f"entity:{TASK}", 0.84, "show"), None, "unsure"),  # just under the bar: not trusted
        (("agentic", 0.99, "show"), None, "agentic"),
        (None, DecisionError("rate_limited", "slow down"), "rate_limited"),
        (None, DecisionError("unavailable", "hub down"), "unavailable"),
    ],
)
async def test_anything_short_of_a_confident_open_goes_to_the_assistant(hub, answer, error, reason):
    hub["answer"], hub["error"] = answer, error
    r = await navigator.route("summarize the zoom oauth task")
    assert (r.route, r.target, r.reason) == ("agentic", None, reason)
    # Why it fell back is debuggable: the request always, the response whenever the model answered.
    assert r.run.reason == reason and r.run.decision.request is hub["specs"][0]
    assert (r.run.decision.response is None) == (error is not None)


def test_every_screen_offered_is_a_real_address_and_none_is_offered_twice():
    options, _ = navigator.static_options()
    for key in options:
        if key.startswith("view:"):
            assert parse_dock_url("/dock/" + key[len("view:") :]) is not None, key
    assert "view:assistant" not in options, "the assistant is where the request was typed"
    assert not {"view:triggers", "view:signals", "view:cron"} & set(options), "one Events screen, not four"


def test_an_entity_is_offered_once_unless_its_id_opens_a_different_screen():
    """``conversation/<id>`` beside the conversation entity is the same place twice; the two split
    the probability until neither clears the bar (measured 0.59 / 0.53)."""
    conv = "conversation-1e6f7a8b-9c0d-4e5f-9a6b-7c8d9e0f1a2b"
    opts = navigator.options_for(None, [{"typeid": conv, "type": "conversation", "title": "Dana"}])
    assert [k for k in opts if conv.split("-", 1)[1] in k] == [f"entity:{conv}"]
    proj = "project-6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
    here = navigation.kind("navigation.here").model_validate({"project": {"typeid": proj}})
    opts = navigator.options_for(here, [])
    # The graph's pointer is ``<type>/<id>``: a bare id is "Graph root not found".
    assert {f"entity:{proj}", f"view:graph/project/{proj.split('-', 1)[1]}"} <= set(opts)


def test_a_screen_an_entity_opens_is_offered_in_the_words_people_use():
    """Measured live: offered as bare "Lens", "open this session's transcript" fell under the bar
    (0.3); with the screen's aliases it opens."""
    proc = "agentic_process-7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
    ref = {"typeid": proc, "title": "refactor", "harness": "claude", "session": "s-1"}
    here = navigation.kind("navigation.here").model_validate({"process": ref})
    lens = navigator.options_for(here, [])["view:lens/claude/transcript/s-1"]
    assert "transcript" in lens and "'refactor'" in lens


def test_a_screen_that_needs_what_the_context_lacks_is_not_offered():
    """A transcript is filed under the harness's own session id: without it there is no address."""
    proc = "agentic_process-7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
    here = navigation.kind("navigation.here").model_validate({"process": {"typeid": proc}})
    assert not [k for k in navigator.options_for(here, []) if k.startswith("view:lens/")
                and "/transcript/" in k]


@pytest.mark.parametrize("utterance", ["open tags", "open tasks", "open agentz stuff", "open the thing"])
def test_a_typo_rule_never_turns_one_screen_into_another(utterance):
    """Look-alike screens (tasks / tags ~0.67) and loose phrases stay below the typo bar."""
    hit = navigator.rule_hit(utterance)
    core = utterance.split(" ", 1)[1]
    # An exact type name opens that type's list ("tags" -> the tag list): a name, not a typo.
    assert (
        hit is None
        or hit.value.split("/")[0].replace("-", " ") in (core, core.rstrip("s"))
        or hit.value == f"assets/list/{core.rstrip('s')}"
    ), hit


@pytest.mark.parametrize(
    "utterance",
    ["open smart navigation log", "show me the navigation log", "open SmartNavigationLog", "Open your log", "show me your logs"],
)
def test_asking_for_its_own_log_is_a_rule(utterance):
    """The classifier opens its own log without asking a model -- by name, or as "your" log."""
    hit = navigator.rule_hit(utterance)
    assert (hit.kind, hit.value) == ("log", "smart-navigation")


@pytest.mark.parametrize("utterance", ["discover", "open discover", "show me the marketplace"])
def test_asking_for_discover_is_a_rule(utterance):
    """Discover is an app page with no place on the map, so its name is a rule of its own."""
    hit = navigator.rule_hit(utterance)
    assert (hit.kind, hit.value) == ("url", "/discover")


@pytest.mark.parametrize("utterance", ["open the log", "open my log", "open your log of this session"])
def test_a_log_not_said_to_it_is_not_its_own(utterance):
    """Only "your" names the navigator: "the log" / "my log" could be any log, so the model decides."""
    hit = navigator.rule_hit(utterance)
    assert hit is None or hit.kind != "log", hit


def _result(target: dict, scope: dict | None = None):
    from flow_sdk.schema.data_spec.decision_spec import DecisionResult

    def choice(probs):
        top = max(probs, key=probs.get)
        return {"type": "choice", "choice": top, "confidence": probs[top], "probabilities": probs}

    answers = {"target": choice(target)}
    if scope is not None:
        answers["scope"] = choice(scope)
    return DecisionResult.model_validate({"answers": answers})


def test_a_request_that_only_names_a_thing_opens_the_place_that_clearly_leads():
    """Measured: ``agentic`` as runner-up on a plain request ("show specs", "change the view mode")
    was the scope question's job -- answered "only", the leading place was right every time."""
    plain = _result({"view:assets/list/spec": 0.45, "agentic": 0.4, "view:x": 0.03}, {"only": 0.97, "more": 0.03})
    assert navigator._acted_on(plain) == "view:assets/list/spec"


def test_without_a_plain_scope_or_a_clear_lead_it_still_hands_over():
    unsure_scope = _result({"view:assets/list/spec": 0.45, "agentic": 0.4, "view:x": 0.03}, {"only": 0.7, "more": 0.3})
    assert navigator._acted_on(unsure_scope) is None
    split = _result({"view:a": 0.4, "view:b": 0.35, "agentic": 0.25}, {"only": 0.99, "more": 0.01})
    assert navigator._acted_on(split) is None


def test_a_clear_lead_acts_below_the_confidence_bar():
    assert navigator._acted_on(_result({"view:a": 0.6, "view:b": 0.2, "agentic": 0.2})) == "view:a"


def test_a_type_name_opens_its_list_and_a_screen_name_still_wins():
    assert navigator.rule_hit("show specs").value == "assets/list/spec"
    assert navigator.rule_hit("open the project manifest").value == "assets/list/project_manifest"
    assert navigator.rule_hit("show my tasks").value == "tasks", "the Tasks screen owns the word"
    assert navigator.rule_hit("open the help desk") is None, "a screen that needs a pointer owns its name too"


def test_this_projects_or_sessions_thing_is_the_screen_that_opens_on_it():
    proj = "project-6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
    here = navigation.kind("navigation.here").model_validate(
        {"project": {"typeid": proj}, "process": {"typeid": "agentic_process-7a2b", "harness": "claude", "session": "s1"}}
    )
    assert navigator.context_rule("show this project's connections", here).value == f"credentials/connections/{proj[8:]}"
    assert navigator.context_rule("show this session's transcript", here).value == "lens/claude/transcript/s1"
    # The room is not in context: no address, so no rule.
    assert navigator.context_rule("open this project's room", here) is None


async def test_a_conversation_is_found_by_its_title_from_a_whole_sentence():
    # The real search, no stand-in: a saved conversation, the sentence a person types for it.
    from flow_sdk.builtin.conversation import Conversation

    saved = await Conversation(title="Plumber (WhatsApp)").save()
    found = await navigator._candidates("the whatsapp chat with the plumber, open that one")
    assert {"typeid": f"conversation-{saved.id}", "type": "conversation", "title": "Plumber (WhatsApp)"} in found


async def test_an_exact_name_is_found_over_whatever_was_edited_lately():
    # Recency breaks ties only: a thing named exactly is offered first however long ago it changed.
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import text

    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.db import get_db_driver
    from flow_sdk.db.drivers.sqlite.sqlite_driver import FtsEntry

    old = await Conversation(title="connect-data-source").save()
    for i in range(6):
        recent = await Conversation(title=f"notes {i}").save()
        # A body that keeps saying the request's common words -- what a skill's SKILL.md does.
        await get_db_driver().fts_upsert(
            FtsEntry(entity_id=str(recent.id), entity_type="conversation", name=f"notes {i}", title=f"notes {i}",
                     content="this skill helps an agent; the agent uses the skill " * 5)
        )
    # The rest of an index: unrelated rows, so "skill" and "agent" are as uncommon as they really are.
    for i in range(80):
        await get_db_driver().fts_upsert(FtsEntry(entity_id=f"filler-{i}", entity_type="markdown", name=f"doc {i}", content="quarterly numbers"))
    stale = (datetime.now(timezone.utc) - timedelta(days=21)).isoformat()
    async with get_db_driver().session_factory() as session:
        await session.execute(
            text("UPDATE entities SET updated_date = :d, data = json_set(data, '$.updated_date', :d) WHERE id = :id"),
            {"d": stale, "id": str(old.id)},
        )
        await session.commit()
    found = await navigator._candidates("open the connect-data-source skill this agent leans on")
    assert found[0]["typeid"] == f"conversation-{old.id}"


async def test_search_in_a_fresh_process_opens_the_database_instead_of_finding_nothing():
    # A CLI (the eval) searches before anything else opened the database; it must find, not return [].
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.db import get_db_driver

    saved = await Conversation(title="Acme pilot").save()
    await get_db_driver().close()
    found = await navigator._candidates("my convo with the acme folks about the pilot")
    assert f"conversation-{saved.id}" in {c["typeid"] for c in found}


def test_a_literal_acts_alone_only_when_it_is_the_whole_request():
    alone = {
        "open ~/notes/plan.md": ("file", "~/notes/plan.md"),
        "go to https://example.com/x": ("url", "https://example.com/x"),
        "search for oauth": ("view", "search?q=oauth"),
        "preview port 5173": ("webapp", "5173"),
    }
    for text, (kind_, value) in alone.items():
        hit = navigator.rule_hit(text)
        assert hit is not None and (hit.kind, hit.value) == (kind_, value), text
    inside = {
        "whats hogging port 8093 on here? flip to the ports": "webapp:8093",
        "add ~/Documents/notes to this index and kick off a rebuild": "file:~/Documents/notes",
        "find everything that mentions the whatsapp webhook": "view:search?q=everything that mentions the whatsapp webhook",
    }
    for text, key in inside.items():
        assert navigator.rule_hit(text) is None, text
        assert key in navigator.literal_option(text), "inside a sentence it is one option for the model"
