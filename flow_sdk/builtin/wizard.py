"""Wizard — a folder-backed AUTONOMOUS setup document.

The counterpart of Journey, and the distinction is why both exist:

    A Journey PRESENTS a step and waits for a person.
    A Wizard DECIDES and executes.

Folder layout::

    <scope>/agentic-assets/wizard/<name>/
        wizard.json     # the document: ordered steps + declared triggers

Disk is the single source of truth for what a wizard DOES. The row carries only
what a list needs (name, description, enabled) and ``spec()`` re-reads the
document, so editing ``wizard.json`` changes behaviour with no re-save.

Progress is not stored here either: a run reports through the shared Activity
mechanism, addressed at ``wizard/<name>`` with this entity as its subject, so a wizard
run appears in the same footer chip as an index walk and a Claude session.
"""
import logging
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Optional

from pydantic import computed_field

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity, action
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

logger = logging.getLogger(__name__)


class Wizard(Entity):
    type: str = APIField(default=EntityType.WIZARD.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    enabled: bool = APIField(default=True, description="The wizard's active switch.")

    _api_visible: ClassVar[bool] = True

    @property
    def folder(self) -> Optional[Path]:
        return Path(self.asset_ref) if self.asset_ref else None

    def spec(self) -> Optional["WizardSpec"]:
        """The parsed ``wizard.json`` — disk is truth, through the ONE reader
        the indexer also uses. ``None`` when the document is missing or
        malformed."""
        from flow_sdk.fs_store.indexer.functions.wizard import read_wizard  # noqa: PLC0415

        return read_wizard(Path(self.asset_ref)) if self.asset_ref else None

    def is_system(self) -> bool:
        """True when this wizard ships inside an SDK system project.

        Systemness is a property of the LOCATION (see
        ``config.is_system_project_path``); a wizard sits a few levels below the
        project dir (``<project>/agentic-assets/wizard/<name>``), so walk up.
        Port of ``Journey.is_system`` — same rule, same reason.

        This is the TRUST boundary. A shipped wizard's command steps are ours
        and run unprompted; anything else came from a repo someone cloned, and
        running its shell one-liners without asking would make "open a project"
        a code-execution primitive.
        """
        from flow_sdk.config import is_system_project_path  # noqa: PLC0415

        if not self.asset_ref:
            return False
        return any(is_system_project_path(p) for p in Path(self.asset_ref).parents)

    @computed_field
    @property
    def shipped(self) -> bool:
        """The trust answer, on the wire — `is_system()` is a method and never
        reaches the UI.

        It carries its own name rather than reusing the base entity's ``system``
        flag, which is a DIFFERENT fact: this very wizard sits under
        ``flow_sdk/system_projects/`` and is trusted by the runner, while its
        entity payload says ``system: false``. A viewer that gated on ``system``
        therefore asked a person to approve a wizard Flowpad ships — a prompt
        that teaches people to click through the one gate that matters.
        """
        return self.is_system()

    @computed_field
    @property
    def run_state(self) -> dict:
        """This wizard's last/current run — inputs given, status, what it waits for.

        A ``@computed_field`` off disk, the way ``Project.customization`` reads
        ``.flow/customization/``: it rides the ordinary entity payload, so the UI
        learns a run is waiting through the machinery it already uses and needs
        no route of its own. Cheap and best-effort — a missing file is the common
        case and means "never run".

        One file per wizard is enough because the lock is one run per NAMED
        wizard: there is no second concurrent run to tell apart, so no run id.
        """
        from flow_sdk.core.wizard.state import read_state  # noqa: PLC0415

        default = {"status": "", "inputs": {}, "awaiting": [], "outcomes": [], "message": ""}
        if not self.id:
            return default
        try:
            state = read_state(str(self.id))
        except Exception:  # noqa: BLE001 — a run summary must never fail a fetch
            return default
        return {**default, **state} if state else default

    @action.post(action_name="set-input")
    async def set_input_action(self) -> ApiResponse:
        """`POST /wizard/<id>/set-input` — `{name, value}`, then run again.

        Resume is a re-run, not a continuation: every precondition is re-asked,
        so steps already done skip and the run walks to the next thing it needs.
        That is why nothing had to persist a cursor.
        """
        from pydantic import TypeAdapter  # noqa: PLC0415

        from flow_sdk.core.wizard.state import set_input  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        name = str((body or {}).get("name") or "").strip()
        if not name:
            return ApiFailResponse(message="name is required", status_code=400)
        if "value" not in (body or {}):
            return ApiFailResponse(message="value is required", status_code=400)
        value = body["value"]

        spec = self.spec()
        if spec is None:
            return ApiFailResponse(message="Wizard document is unreadable", status_code=400)

        declared = next(
            (step.input for step in spec.steps if step.input is not None and step.input.name == name),
            None,
        )
        if declared is None:
            return ApiFailResponse(
                message=f"{self.name or 'This wizard'} declares no input named {name!r}",
                status_code=400,
            )
        if declared.shape is not None:
            try:
                value = TypeAdapter(declared.shape).validate_python(value)
            except Exception as exc:  # noqa: BLE001 — the caller's value, not our bug
                return ApiFailResponse(message=f"{name}: {exc}", status_code=422)

        set_input(str(self.id), name, value)
        # The approval that started this run carries forward; answering a question
        # the wizard asked is not a second decision to run it.
        return await self.run_action(_approved=True)

    @action.post(action_name="run")
    async def run_action(self, _approved: bool = False) -> ApiResponse:
        """`POST /wizard/<id>/run` — execute this wizard to completion.

        The trust gate REFUSES; it never blocks. A non-system wizard needs
        ``approved: true`` in the body, which the UI supplies after a confirm
        dialog. Modelling approval as a run the caller waits on — an activity
        parked in BLOCKED until someone answers — is the shape that hangs a
        headless run forever, so an unattended caller gets an immediate,
        legible refusal instead of a process that never returns.

        An input step does NOT break that rule, because it does not wait either:
        a run missing a value RETURNS ``pending`` and releases the caller. The
        node is left BLOCKED so the chip still shows it as somebody's, and
        ``set-input`` runs the wizard again. Nothing is ever awaited.
        """
        from flow_sdk.core.wizard import WizardNotApproved  # noqa: PLC0415
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        spec = self.spec()
        if spec is None:
            return ApiFailResponse(
                message=f"Wizard document is missing or unreadable at {self.asset_ref!r}",
                status_code=400,
            )
        if not spec.enabled or not self.enabled:
            return ApiFailResponse(message=f"Wizard {self.name!r} is disabled", status_code=409)

        from flow_sdk.core.wizard.state import is_approved, record_approval  # noqa: PLC0415

        trusted = self.is_system()
        if not trusted:
            request_info = get_current_request_info()
            body = await request_info.get_post_data() if request_info else {}
            # Three ways to be approved, and the last two are the same fact:
            # this POST carried it, the caller already established it (set-input
            # resuming a run you approved), or it was recorded on a previous run.
            # Without the recorded form a parked wizard could never be resumed —
            # the approval lived only in the first POST's body.
            granted = (body or {}).get("approved") is True or _approved or is_approved(str(self.id))
            if not granted:
                return ApiFailResponse(
                    message=(
                        f"{self.name or 'This wizard'} is not shipped with Flowpad. It runs commands "
                        "on this machine, so it must be approved before it can run."
                    ),
                    status_code=403,
                )
            record_approval(str(self.id))
            trusted = True

        from flow_sdk.core.wizard.execute import execute_wizard  # noqa: PLC0415

        try:
            result = await execute_wizard(
                str(self.id), spec, self.asset_ref or "",
                trusted=trusted,
                # Scoped to this wizard: the viewer IS watching, so the tree
                # goes to its watchers rather than to every connection.
                subject_entity=str(self.typeid),
            )
        except WizardNotApproved as exc:
            return ApiFailResponse(message=str(exc), status_code=403)
        except RuntimeError as exc:
            # Already running here — `execute_wizard` holds the wizard's slot.
            return ApiFailResponse(message=str(exc), status_code=409)

        return ApiSuccessResponse(data=result.to_payload())
