"""Typed values of the automation wizard, independent of executable block imports."""
from typing import ClassVar

from flow_sdk.schema.data_spec.returned_value_spec import DecisionVerdict, ReturnedValue, TaggedValue
from flow_sdk.schema.data_spec.spec import DataSpec, Tagged


class PreparedAutomation(DataSpec):
    """The value passed from preparation through acceptance to work."""
    spec_kind: ClassVar[str] = "automation.prepared"
    run_id: str
    event_id: str | None = None
    state: TaggedValue = None
    scope_key: str = ""
    subject_target: str = ""
    verdict: Tagged[DecisionVerdict] | None = None
    inputs: dict[str, TaggedValue] = {}


class AutomationGateResult(ReturnedValue):
    spec_kind: ClassVar[str] = "automation.gate_result"
    verdict: Tagged[DecisionVerdict] | None = None
    reason_code: str = ""



class AutomationActionResult(ReturnedValue):
    """A quiet legacy dispatch outcome, with the callee's actual answer preserved."""
    spec_kind: ClassVar[str] = "automation.action_result"
    answer: Tagged[ReturnedValue]
    action_type: str
