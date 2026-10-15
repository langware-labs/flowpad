"""The Python ComputeOp variant; authorization is enforced by the shared runner."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
from typing import Any

from flow_sdk.assets.project_manifest import asset_namespace
from flow_sdk.assets.python_module import load_package_module
from flow_sdk.core.compute_op.context import CallContext
from flow_sdk.schema.data_spec._missing import MISSING
from flow_sdk.schema.data_spec._namespace import loading
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue


def _load_call(context: CallContext):
    folder = context.asset_folder.resolve()
    ns = asset_namespace(folder, None, shipped=context.shipped)
    if not context.shipped and not ns:
        raise ValueError(f"{folder}: Python compute op's project must declare an ontology namespace")
    digest = hashlib.sha256(str(folder).encode())
    for path in sorted(folder.rglob("*.py")):
        if "__pycache__" not in path.parts:
            digest.update(str(path.relative_to(folder)).encode())
            digest.update(path.read_bytes())
    with loading(ns):
        module = load_package_module(folder, "call", "flowpad_call_" + digest.hexdigest(), fresh_source=True)
    call = getattr(module, "call", None)
    if not callable(call):
        raise TypeError(f"{folder / 'call.py'} must define call(input, *, context)")
    return call


async def _thread_call(call, *args, **kwargs):
    """Settle a non-interruptible thread before propagating cancellation."""
    work = asyncio.create_task(asyncio.to_thread(call, *args, **kwargs))
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        while not work.done():
            try:
                await asyncio.shield(work)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        # Retrieve a failure even though cancellation remains the caller's outcome.
        if not work.cancelled():
            work.exception()
        raise


async def run_python(spec, *, input: Any, context: CallContext | None, **_) -> ReturnedValue:
    if context is None:
        raise ValueError("a Python compute op needs its asset folder execution context")
    if input is MISSING:
        input = None
    call = await _thread_call(_load_call, context)
    inspect.signature(call).bind(input, context=context)
    if inspect.iscoroutinefunction(call):
        answer = await call(input, context=context)
    else:
        answer = await _thread_call(call, input, context=context)
        if inspect.isawaitable(answer):
            answer = await answer
    if not isinstance(answer, ReturnedValue):
        raise TypeError(f"{context.asset_folder / 'call.py'} must return ReturnedValue, got {type(answer).__name__}")
    return answer
