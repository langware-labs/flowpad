"""A call that travels on a message, and its answer.

The sender's message carries a ``process_call-<call_id>`` TYPE_ID attachment whose
``prompt_preview`` (a hub-known field) holds a ``ProcessCall``. The receiver approves
it, runs it, and replies with a ``returned_value-<call_id>`` attachment holding the
``ReturnedValue``. Neither is an entity: the call's text is the sender's and is never
indexed on the receiver, and nothing on either side has a row or a folder for them.
"""

import json
from typing import Any, ClassVar, Literal, Optional

from flow_sdk.schema.data_spec.compute_op_spec import ExeData
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue
from flow_sdk.schema.data_spec.spec import DataSpec, Tagged

PROCESS_CALL_TYPE = "process_call"
RETURNED_VALUE_TYPE = "returned_value"
#: What a ``status`` answer carries: the base ``ReturnedValue`` fields (a new one is sent too),
#: minus the output and what ran it on the receiver. A subclass's own output (``PromptResult.text``)
#: is never a base field, so it stays home by construction.
_STATUS_FIELDS = set(ReturnedValue.model_fields) - {"value", "executor", "check"}


class ProcessCall(DataSpec):
    """What to run, and how much of the answer to send back."""

    spec_kind: ClassVar[str] = "process.call"

    #: Pairs the call with its answer — the id in both attachments' ``data``.
    call_id: str
    #: The call itself — today always a ``compute_op.agent`` (``AgentOp``).
    exe: Tagged[ExeData]
    #: ``status``: the answer carries the outcome and one sentence, never the output.
    #: ``full`` is reserved for sending the output back too.
    reply: Literal["status", "full"] = "status"
    #: The sender's run (``CallContext.invocation_id``): the receiver's agent joins that trace,
    #: under this call. Absent from older senders, so the call is then a run of its own.
    invocation_id: Optional[str] = None


def process_call_in(attachments: Any) -> Optional[ProcessCall]:
    """The call a message carries, if any. A malformed one reads as none."""
    from flow_sdk.builtin.flow_message import carried_value  # noqa: PLC0415 — builtin imports data_spec

    found = carried_value(attachments, PROCESS_CALL_TYPE)
    if found is None:
        return None
    try:
        return ProcessCall.model_validate(found[1])
    except ValueError:
        return None


def _attachment(kind: str, call_id: str, payload: dict) -> dict:
    """The attachment dict ``handle_add_message`` adopts (``body["attachment"]``)."""
    return {"attachment_type": "type_id", "data": f"{kind}-{call_id}", "prompt_preview": json.dumps(payload)}


def call_attachment(call: ProcessCall) -> dict:
    return _attachment(PROCESS_CALL_TYPE, call.call_id, call.model_dump(mode="json"))


def answer_attachment(call: ProcessCall, answer: ReturnedValue) -> dict:
    """The answer, cut to what ``call.reply`` allows."""
    include = None if call.reply == "full" else _STATUS_FIELDS
    return _attachment(RETURNED_VALUE_TYPE, call.call_id, answer.model_dump(mode="json", include=include))
