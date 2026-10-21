"""The Python ComputeOp variant; authorization is enforced by the shared runner."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import os
from pathlib import Path
from typing import Any

from flow_sdk.assets.project_manifest import asset_namespace
from flow_sdk.assets.python_module import load_package_module
from flow_sdk.core.compute_op.context import CallContext
from flow_sdk.schema.data_spec._missing import MISSING
from flow_sdk.schema.data_spec._namespace import loading
from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue


#: ``block_version`` per folder, keyed by every file's path, mtime and size: a changed file re-hashes.
_versions: dict[Path, tuple[tuple, str]] = {}


def _block_files(folder: Path) -> list[Path]:
    """The block's files, never walking into ``__pycache__`` or a dot-dir."""
    found = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith(".")]
        found += [Path(root) / name for name in files if not name.startswith(".")]
    return sorted(found)


def block_version(folder: Path) -> str:
    """What a block IS: a hash of every file in its folder (``compute_op.json``, ``call.py``, prompts, helpers).

    Two calls with one version ran the same block; a log row carries it, so an eval tells versions apart.
    """
    folder = Path(folder).resolve()
    files = _block_files(folder)
    key = tuple((p, (st := p.stat()).st_mtime_ns, st.st_size) for p in files)
    held = _versions.get(folder)
    if held is not None and held[0] == key:
        return held[1]
    digest = hashlib.sha256()
    for path in files:
        digest.update(str(path.relative_to(folder)).encode())
        digest.update(path.read_bytes())
    version = digest.hexdigest()[:12]
    _versions[folder] = (key, version)
    return version


def load_module(context: CallContext):
    """The block's ``call.py`` as a module -- loaded fresh, under its project's namespace."""
    folder = context.asset_folder.resolve()
    ns = asset_namespace(folder, None, shipped=context.shipped)
    if not context.shipped and not ns:
        raise ValueError(f"{folder}: Python compute op's project must declare an ontology namespace")
    # The module's name: where it lives and what it is, so a changed block is a fresh module.
    name = f"flowpad_call_{hashlib.sha256(str(folder).encode()).hexdigest()[:12]}_{block_version(folder)}"
    with loading(ns):
        return load_package_module(folder, "call", name, fresh_source=True)


def _load_call(context: CallContext):
    folder = context.asset_folder.resolve()
    call = getattr(load_module(context), "call", None)
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
