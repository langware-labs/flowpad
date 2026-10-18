"""The Smart Navigator as a FlowCall block: ``navigator.request`` -> ``navigation.outcome``.

Both answers are OK: a dock to open, and the prompt handed to the assistant (also what an
unsure or absent decision API answers). How it was decided rides on the ``NavigatorResult``.
The engine is ``flow_sdk.core.navigation_decision``.

Logged by FlowCall's block log (``log`` in ``compute_op.json``): SmartNavigationLog, while its
preference is on, one ``navigator.dataset`` row per decision (``log_row``). A ``replay`` (an eval)
is no decision, so it is not logged.
"""

from flow_sdk.core import navigation_log
from flow_sdk.core.navigation_decision import decide_run
from flow_sdk.schema.data_spec.navigator_spec import NavigatorResult


async def call(input, *, context) -> NavigatorResult:
    request = input.model_dump(mode="json", exclude_none=True) if hasattr(input, "model_dump") else input
    outcome, answer = await decide_run(request)
    target = outcome.decision.target
    detail = "ask the assistant" if outcome.prompt else f"open {outcome.address or (target.value if target else '')}"
    return NavigatorResult.satisfied(
        detail, value=outcome, reason=answer.reason, latency_ms=answer.latency_ms, run=answer.run
    )


def log_row(request, answer):
    """The block log's row: a ``navigator.dataset`` row -- None for a replay or an empty request."""
    if request.get("replay") or not (request.get("utterance") or "").strip() or not answer.has_value:
        return None
    return navigation_log.row_of(request, answer.value, answer)
