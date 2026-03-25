"""Tests for template_engine.dependency."""

import pytest

from flow_sdk.template_engine.dependency import topological_sort
from flow_sdk.template_engine.errors import CircularDependencyError


def test_linear_chain():
    """a depends on b depends on c (context var)."""
    order = topological_sort({"a": ["b"], "b": ["c"]})
    assert order.index("c") < order.index("b") < order.index("a")


def test_context_vars_first():
    """Refs not in template keys are context vars and come first."""
    order = topological_sort({"tpl": ["ctx_var"]})
    assert order.index("ctx_var") < order.index("tpl")


def test_no_deps():
    order = topological_sort({"a": [], "b": []})
    assert set(order) == {"a", "b"}


def test_diamond():
    #   root
    #  /    \
    # mid1  mid2
    #  \    /
    #   leaf
    order = topological_sort({
        "root": ["mid1", "mid2"],
        "mid1": ["leaf"],
        "mid2": ["leaf"],
        "leaf": [],
    })
    assert order.index("leaf") < order.index("mid1")
    assert order.index("leaf") < order.index("mid2")
    assert order.index("mid1") < order.index("root")
    assert order.index("mid2") < order.index("root")


def test_circular_dependency():
    with pytest.raises(CircularDependencyError):
        topological_sort({"a": ["b"], "b": ["a"]})


def test_self_loop():
    with pytest.raises(CircularDependencyError):
        topological_sort({"a": ["a"]})


def test_empty():
    assert topological_sort({}) == []
