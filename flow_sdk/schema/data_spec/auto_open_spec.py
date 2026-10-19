"""What an agent's ``auto_open`` entry may be: a place, a navigation op, or a wizard.

* a ``DockPointerSpec`` (``{"viewType": ..., "pointer": ...}``) — show it; the answer
  is recorded, nothing repairs it;
* ``{"op": "<compute_op>"}`` — a ``navigate`` op in the agent's own project: shown at
  once, then run in the background, where its ``attempts`` repair what the navigation
  found (a server that is down) and it opens again;
* ``{"wizard": "<wizard>"}`` — a wizard in the agent's own project, run in the
  background; its steps may navigate.

The key decides — never "whichever shape happens to validate".
Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Union

from pydantic import BeforeValidator, ConfigDict

from flow_sdk.schema.data_spec.dock_pointer_spec import DockPointerSpec
from flow_sdk.schema.data_spec.spec import DataSpec


class AutoOpenOp(DataSpec):
    """Open the place a ``navigate`` op names, and let the op repair it."""

    spec_kind: ClassVar[str] = "auto_open.op"
    model_config = ConfigDict(extra="forbid", frozen=True)

    #: The op's name, resolved in the agent's own project or a direct context folder.
    op: str


class AutoOpenWizard(DataSpec):
    """Run a wizard in the background when a session opens."""

    spec_kind: ClassVar[str] = "auto_open.wizard"
    model_config = ConfigDict(extra="forbid", frozen=True)

    #: The wizard's name, resolved like ``AutoOpenOp.op``.
    wizard: str


def _entry_by_key(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    if "op" in value:
        return AutoOpenOp.model_validate(value)
    if "wizard" in value:
        return AutoOpenWizard.model_validate(value)
    return DockPointerSpec.model_validate(value)


AutoOpenEntry = Annotated[Union[DockPointerSpec, AutoOpenOp, AutoOpenWizard], BeforeValidator(_entry_by_key)]
