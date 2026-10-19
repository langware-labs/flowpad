"""In-process capabilities of a FlowCall invocation, never a wire payload."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core.compute.declared_value import MISSING, DeclaredShapeError, to_declared
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.value_ref import parse_ref


@dataclass
class CallContext:
    asset_folder: Path
    workdir: Path | None = None
    project: str | None = None
    invocation_id: str = field(default_factory=lambda: str(mint_uuid()))
    #: This call's id, minted by ``run_op``; None until then. A context handed to ``run_op`` that
    #: already names a call is its caller's, and that call becomes the parent.
    call_id: str | None = None
    #: The call that made this one; None for a run's root. With ``invocation_id`` it is the run's tree.
    parent_call_id: str | None = None
    parent: Any = None
    shipped: bool = False
    on_executor: Callable[[str], None] | None = None

    def attach_executor(self, executor: str) -> None:
        """Associate a launched child with this call before awaiting its work."""
        if self.on_executor is not None:
            self.on_executor(executor)

    async def call(self, ref: str, *, input: Any = MISSING, approved: bool = False):
        """Call within the owning project; approval is explicit for each callee."""
        from flow_sdk.builtin.compute_op import ComputeOp  # noqa: PLC0415
        from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue  # noqa: PLC0415

        op = await ComputeOp.resolve(ref, project=self.project)
        if op is None:
            return ReturnedValue.not_found(f"No compute op {ref!r}")
        child = self.parent.child(f"{op.name or op.id}-{mint_uuid()}") if self.parent is not None else None
        return await op.call(input=input, approved=approved, workdir=self.workdir,
                             parent=child, invocation_id=self.invocation_id, parent_call_id=self.call_id,
                             on_executor=self.on_executor)

    async def resolve(self, value: Any, *, near: Path | str | None = None) -> Any:
        """Materialize refs in an explicit store (default: this block's); no global search."""
        from flow_sdk.values import resolve_ref, store_of  # noqa: PLC0415

        if parsed := parse_ref(value):
            try:
                held = await asyncio.to_thread(resolve_ref, value, near if near is not None else store_of(self.asset_folder))
                return to_declared(held, parsed[0])
            except (LookupError, ValueError) as exc:
                raise DeclaredShapeError(f"Cannot resolve {value}: {exc}") from exc
        if isinstance(value, list):
            return [await self.resolve(item, near=near) for item in value]
        if isinstance(value, dict):
            return {key: await self.resolve(item, near=near) for key, item in value.items()}
        if isinstance(value, DataSpec):
            changes = {name: await self.resolve(getattr(value, name), near=near) for name in type(value).model_fields}
            return value.model_copy(update=changes)
        return value


__all__ = ["CallContext", "MISSING"]
