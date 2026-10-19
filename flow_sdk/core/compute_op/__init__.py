"""ComputeOp — ONE call: a goal to reach or a value to produce.

The runner is pure (no entity, no DB); ``flow_sdk/builtin/compute_op.py`` is the
indexed asset on top of it.

``ask`` and ``ask_window`` live here too: putting the question to a person is one
of the four calls an op can make, and since a wizard stopped having an ask step
of its own the op is the only caller. No re-exports — a caller imports from the
submodule that owns the symbol.
"""

from flow_sdk.core.compute_op.runner import check_op, run_op

__all__ = ["check_op", "run_op"]
