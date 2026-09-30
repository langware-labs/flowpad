"""Action lookup honours the request's HTTP method (generic-open plan, U3).

A type-scoped action shadows a generic one of the same name for that type
(``<type>.<name>`` is tried before ``<name>``). That is right when the scoped
action serves the request's method — and wrong when it doesn't: the POST
instance ``agentic_process.open`` would swallow a GET deep link meant for the
generic GET ``open``. With the method, a scoped action that doesn't take it
falls back to the generic action that does; without the method (or when the
generic one doesn't take it either) lookup is exactly what it was.
"""

from __future__ import annotations

from flow_sdk.actions.action_registry import ActionManager


def _registry() -> ActionManager:
    am = ActionManager()
    am.register("alpha.zz", "scoped_post", lambda: "scoped", methods="post")
    am.register("zz", "generic_get", lambda: "generic", methods="get")
    am.register("beta.zz", "scoped_any", lambda: "scoped-any", methods="all")
    am.register("gamma.yy", "scoped_post_only", lambda: "scoped-yy", methods="post")
    am.register("yy", "generic_post", lambda: "generic-yy", methods="post")
    return am


def test_a_scoped_action_that_takes_the_method_still_wins():
    am = _registry()
    assert am.get_by_name("zz", "alpha", method="post").function_name == "scoped_post"
    assert am.get_by_name("zz", "beta", method="get").function_name == "scoped_any"


def test_a_scoped_action_that_does_not_take_the_method_falls_back_to_the_generic_one():
    am = _registry()
    assert am.get_by_name("zz", "alpha", method="get").function_name == "generic_get"
    assert am.get_by_name("zz", "alpha", method="GET").function_name == "generic_get"


def test_without_a_method_lookup_is_unchanged():
    am = _registry()
    assert am.get_by_name("zz", "alpha").function_name == "scoped_post"
    assert am.get_by_name("zz").function_name == "generic_get"


def test_no_generic_action_that_takes_the_method_keeps_the_scoped_one():
    """Nothing better to route to: the scoped action answers (and rejects) as before."""
    am = _registry()
    assert am.get_by_name("yy", "gamma", method="get").function_name == "scoped_post_only"


def test_an_unscoped_type_uses_the_generic_action():
    am = _registry()
    assert am.get_by_name("zz", "delta", method="get").function_name == "generic_get"
