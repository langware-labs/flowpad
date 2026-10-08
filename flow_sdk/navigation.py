"""The smart navigator, as the public SDK: what was typed (and where) in, a dock OR a prompt out.

    from flow_sdk.navigation import decide
    outcome = await decide({"utterance": "open data sources", "here": {"view": "home"}})

``request`` is a ``navigator.request``; the answer a ``navigation.outcome``. ``decide_run`` also
answers the engine's own ``navigator.route``, whose ``run`` is how the model decided (``navigator.run``:
its full request and response) -- what a log or an eval keeps to debug a decision. ``candidates`` replays a
recorded set of search matches instead of searching -- what an eval does. The implementation lives
in ``flow_sdk.core.navigation_decision``; callers outside the core (a dataset's ``eval.py``) use this.
"""

from flow_sdk.core.navigation_decision import address_of as _address_of
from flow_sdk.core.navigation_decision import decide, decide_run
from flow_sdk.core.navigator import MIN_CONFIDENCE  # below this the navigator does not act
from flow_sdk.schema.data_spec.navigator_spec import NavigationTarget


def address_of(target) -> "str | None":
    """The dock address a target (``navigator.target`` or its dict) opens, or None."""
    return _address_of(NavigationTarget.model_validate(target))


__all__ = ["MIN_CONFIDENCE", "address_of", "decide", "decide_run"]
