"""FlowData's repr previews any flow_value: a dict (the default) or an error payload must not raise.

A failing session's history held a dict-valued FlowData, and repr() raised
"unhashable type: 'slice'" — which is what a diagnostic printing the history hit,
so the real cause (an OpenRouter 402) never reached the assertion message.
"""
import pytest

from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.parametrize("value", [{}, {"error": "402 requires more credits"}, ["a", "b"], "plain text", 42, None])
def test_repr_previews_any_flow_value(value):
    item = FlowData(flow_value=value)
    text = repr(item)
    assert text.startswith("FlowData(")
    assert str(value)[:10] in text
