"""ComputeOp — a call: a goal to reach or a value to produce, and the ordered
attempts that get there.

The runner is pure (no entity, no DB); ``flow_sdk/builtin/compute_op.py`` is the
indexed asset on top of it.
"""

from flow_sdk.core.compute_op.runner import (
    AttemptResult,
    ComputeOpNotApproved,
    check_op,
    run_op,
)

__all__ = ["AttemptResult", "ComputeOpNotApproved", "check_op", "run_op"]
