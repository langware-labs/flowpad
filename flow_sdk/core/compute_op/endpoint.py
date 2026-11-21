"""An ``endpoint`` op, called: one capability of a hub ``APIEndpoint``, as a FlowCall block.

The op names WHAT it does (``EndpointOp.kind``: ``image.generate``, ``video.generate``); the request
in scope and the result it returns are that capability's own specs (``flow_sdk.endpoint_call``). Which
vendor answers is the hub's business and the dialect's, never the op's.

A call that did not produce its value is an answer, never a raise: NOT_YET with the closed ``reason``
as a field (``EndpointAnswer``), and the vendor's job id when one was started, so a job cut short can
be looked up rather than started again.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from flow_sdk.schema.data_spec.compute_op_spec import EndpointOp
from flow_sdk.schema.data_spec.returned_value_spec import EndpointAnswer, ReturnedValue

#: Reasons that mean the vendor was never asked to do the work.
_NOTHING_RAN = frozenset({"invalid_request", "no_endpoint", "auth", "budget_used", "rate_limited"})


async def endpoint_op(op: EndpointOp, request: Any, *, out_dir: Optional[Path] = None) -> ReturnedValue:
    """Run the op's capability on ``request`` and answer its result as the value. Never raises."""
    from flow_sdk.endpoint_call import EndpointCallError, call  # noqa: PLC0415 — the hub client, behind the schema

    dump = getattr(request, "model_dump", None)
    plain = dump(mode="json") if callable(dump) else request
    try:
        result = await call(op.kind, plain, endpoint=op.endpoint or None, out_dir=out_dir)
    except EndpointCallError as exc:
        job = f" (job {exc.job_id})" if exc.job_id else ""
        return EndpointAnswer.not_yet(
            f"{op.kind} did not finish: {exc.message}{job}",
            ran=exc.reason not in _NOTHING_RAN,
            timed_out=exc.reason == "timed_out",
            reason=exc.reason,
            job_id=exc.job_id,
        )
    return EndpointAnswer.satisfied(f"{op.kind} done", value=result)
