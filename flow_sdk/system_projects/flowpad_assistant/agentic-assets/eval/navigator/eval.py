"""The SmartNavigator eval: each example through the official inference, judged against its golds.

The input is the example's own ``navigator.request`` (utterance + here) and its RECORDED search
candidates -- never this machine's search -- so a run is judged on the options the example was
labelled against. The decision API is whatever the hub offers (``versions`` names it).
"""

from flow_sdk.evals import EvalTrace, ExampleEval, Verdict, golds, verdict_of
from flow_sdk.navigation import MIN_CONFIDENCE, address_of, decide_run


def _right(target, golds):
    """``target`` opens a right answer: one of the quick golds, as named or at the same address."""
    return any(g.get("route") == "quick" and _lands_on(target, g.get("target")) for g in golds)


def _lands_on(target, gold_target):
    """The same place: the same target, or two that open one address (a session as an entity and
    as its screen, ``entity:agentic_process-x`` / ``view:agentic_process/x``)."""
    if not target or not gold_target:
        return False
    if target == gold_target:
        return True
    there = address_of(target)
    return there is not None and there == address_of(gold_target)


async def evaluate_example(row):
    recorded = row.context.candidates if row.context else []
    out, answer = await decide_run(
        row.input.model_dump(mode="json", exclude_none=True),
        candidates=[c.model_dump(mode="json", exclude_none=True) for c in recorded],
    )
    pred = out.decision.model_dump(mode="json", exclude_none=True)
    answers = [g.model_dump(mode="json", exclude_none=True) for g in golds(row)]
    gold_kinds = {(g.get("target") or {}).get("kind") for g in answers if g.get("route") == "quick"}
    expects_agentic = any(g.get("route") == "agentic" for g in answers)
    verdict = verdict_of(pred, row, abstained=pred["route"] == "agentic" and not expects_agentic)
    if verdict == Verdict.WRONG and pred["route"] == "quick" and _right(pred.get("target"), answers):
        verdict = Verdict.CORRECT
    # Feasible: one step can answer it -- a right answer was among the options offered (or a rule
    # names it). The rest need context the request did not carry.
    decision = answer.run.decision if answer.run else None
    offered = set(decision.request.questions["target"].options) if decision else set()
    feasible = (
        expects_agentic
        or answer.reason == "rule"
        or any(_right(dict(zip(("kind", "value"), k.split(":", 1))), answers) for k in offered if ":" in k)
    )
    # Right is not enough: the person must land there. A right target nothing can open (an entity
    # with no address) is handed to the assistant in the app -- so here it is not correct either.
    unopenable = pred["route"] == "quick" and out.prompt is not None
    if verdict == Verdict.CORRECT and unopenable:
        verdict = Verdict.WRONG
    return ExampleEval(
        prediction=pred,
        verdict=verdict,
        score=out.decision.confidence,
        # How it was decided -- every option the model was offered and the probability it gave each.
        trace=EvalTrace(kind="navigator.run", value=answer.run.model_dump(mode="json", exclude_none=True)),
        note=(
            "It picked a target nothing can open, so the app hands the request to the assistant -- "
            "counted wrong: the person must land there."
        )
        if unopenable
        else "",
        labels={
            # "no": no right answer was among the options -- the context lacked what it takes.
            "feasible": "yes" if feasible else "no",
            "gold": "agentic" if expects_agentic else "/".join(sorted(k or "?" for k in gold_kinds)),
            "did": "assistant" if out.prompt is not None else (out.address or "ui-built"),
            **({"opens": "no" if unopenable else "yes"} if pred["route"] == "quick" else {}),
        },
    )


def _target_ok(e):
    """It opened a right target (the verb aside -- coverage is where the verb counts)."""
    return _right((e.prediction or {}).get("target"), e.golds)


def _pct(n, d):
    return round(n / d, 4) if d else None


def aggregate(results):
    judged = [e for e in results if e.verdict != Verdict.ERROR]
    quick_out = [e for e in judged if (e.prediction or {}).get("route") == "quick"]
    quick_gold = [e for e in judged if e.golds and e.golds[0].get("route") == "quick"]
    agentic_gold = [e for e in judged if e.golds and e.golds[0].get("route") == "agentic"]
    feasible = [e for e in judged if e.labels.get("feasible") == "yes"]
    return {
        # of the times it opened something, how often it was right
        "precision": _pct(sum(_target_ok(e) for e in quick_out), len(quick_out)),
        # of the examples whose answer is "open X", how many it fully got
        "coverage": _pct(sum(e.verdict == Verdict.CORRECT for e in quick_gold), len(quick_gold)),
        # of the examples that belong to the assistant, how many it handed over
        "agentic_recall": _pct(sum((e.prediction or {}).get("route") == "agentic" for e in agentic_gold), len(agentic_gold)),
        # opened the wrong thing while sure -- the failure the design exists to avoid (a count)
        "confident_wrong": sum((e.score or 0) >= MIN_CONFIDENCE and not _target_ok(e) for e in quick_out),
        # accuracy over what the current architecture can express at all
        "feasible_accuracy": _pct(sum(e.verdict == Verdict.CORRECT for e in feasible), len(feasible)),
    }


async def versions():
    """The decision endpoint, and the map its screens came from -- a value, so the runner keeps it
    once in the dataset and the run names that exact version (``navigation.map.id.<uuid>``)."""
    from flow_sdk.core.navigation import navigation_map
    from flow_sdk.decision import decision_endpoints

    endpoints = await decision_endpoints()
    return {"decision_api": endpoints[0].name if endpoints else "none", "map": navigation_map()}
