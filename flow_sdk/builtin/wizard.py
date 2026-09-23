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
    from flow_sdk.schema.data_spec.returned_value_spec import WizardResult
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
        from flow_sdk.assets.types.wizard import read_wizard

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
    def agent(self) -> str:
        """The agent that drives this CONVERSATIONAL wizard, or "".

        Declared at the top of the document, not inferred from a step. The row
        otherwise carries only what a list needs (name, description, step count)
        — the document is the source of truth for what a wizard does — but a
        launcher has to know which sub-agent to embed before it spawns anything,
        and reading the whole document from the frontend to learn one string
        would put the parse in the wrong tier.

        Empty for a stepped wizard: those are run by the backend runner, which
        reads each step's own agent as it reaches it. The two shapes are mutually
        exclusive and `WizardSpec` refuses a document that is both.
        """
        spec = self.spec()
        return spec.agent if spec is not None else ""

    @computed_field
    @property
    def document_error(self) -> str:
        """Why this wizard has no steps, or ``""``.

        `read_wizard` swallows — deliberately, so one bad document cannot wedge
        an indexer walking a hundred assets — which made a broken `wizard.json`
        indistinguishable from "no wizard here" at every surface. This is the
        diagnostic, on the payload the viewer already has.
        """
        from flow_sdk.assets.types.wizard import wizard_document_problem

        # Shares its read and its parse with `agent` through the reader's memo,
        # so asking both questions on every serialization costs one of each.
        # `wizard_document_problem` is total — every failure mode already comes
        # back as a string — so there is nothing here left to guard against.
        return wizard_document_problem(Path(self.asset_ref)) if self.asset_ref else ""

    @computed_field
    @property
    def activity_path(self) -> str:
        """Where this wizard's run reports progress.

        On the payload so the frontend does not re-derive `execute_wizard`'s
        slug convention — two spellings of one address is how a viewer ends up
        subscribed to a tree nothing writes to.
        """
        from flow_sdk.core.wizard.execute import activity_path_for  # noqa: PLC0415

        return activity_path_for(str(self.id), self.asset_ref or "")

    @computed_field
    @property
    def run_state(self) -> dict:
        """This wizard's last run — its ``WizardResult`` without step output, and
        whether a person approved it.

        A ``@computed_field`` off disk, the way ``Project.customization`` reads
        ``.flow/customization/``: it rides the ordinary entity payload, so the UI
        learns a run finished through the machinery it already uses and needs no
        route of its own. Cheap and best-effort — a missing file is the common
        case and means "never run".

        One file per wizard is enough because the lock is one run per NAMED
        wizard: there is no second concurrent run to tell apart, so no run id.
        """
        from flow_sdk.core.wizard.state import read_state, strip_heavy  # noqa: PLC0415

        if not self.id:
            return {"result": None, "approved": False}
        try:
            # The STORED dump, stripped — never re-validated here: this rides
            # every row of `GET /graph/wizard` and every WS push, and `read_state`
            # is already cached on the file's stamp. `run-detail` validates it
            # whole. A record in any other shape is "never run".
            state = read_state(str(self.id))
            raw = state.get("result")
            return {
                "result": strip_heavy(raw) if isinstance(raw, dict) and "exit_code" in raw else None,
                "approved": bool(state.get("approved")),
            }
        except Exception:  # noqa: BLE001 — a run summary must never fail a fetch
            return {"result": None, "approved": False}

    async def run(self, *, approved: bool = False, unattended: bool = False) -> "WizardResult":
        """Run this wizard, and answer what it did. Never raises for an outcome.

        The OOP twin of ``ComputeOp.run``: a caller in Python drives the entity,
        not a route. ``run_action`` is this plus the HTTP shapes — the approval
        it reads off a POST body, and the status codes an answer maps to. EVERY
        gate lives here (missing, disabled, conversational, unapproved), so a
        trigger meets exactly what a person does.

        ``unattended`` reports at INSTANCE scope instead of on this entity.
        `_send` routes by subject entity: one naming an entity reaches only its
        WATCHERS, while an unscoped one belongs to the box and is broadcast. A
        trigger-fired run fires at boot, before anyone has opened the wizard and
        usually before a browser exists, so entity scope addressed a complete
        progress tree to an audience of zero. It changes only WHO SEES the run,
        never who may start one — ``execute_wizard`` holds the wizard's slot.
        """
        from flow_sdk.core.wizard.execute import execute_wizard  # noqa: PLC0415
        from flow_sdk.core.wizard.runner import wizard_refused  # noqa: PLC0415
        from flow_sdk.schema.data_spec.returned_value_spec import WizardResult  # noqa: PLC0415

        spec = self.spec()
        if spec is None:
            return WizardResult.not_found(f"{self.name or self.asset_ref}: the document is missing or unreadable.")
        if not spec.enabled or not self.enabled:
            # Here, not at the HTTP edge: a trigger or a Python caller must meet
            # the same gate a person does.
            return WizardResult.refused(f"{self.name or 'This wizard'} is disabled.")
        if spec.agent:
            # A CONVERSATIONAL wizard has no steps to run. Its agent talks to the
            # person, and the caller supplies the prompt and the payload when it
            # launches — none of which exist here. Running it "anyway" would spawn
            # the agent against no payload at all, and because a shipped wizard
            # needs no approval, nothing would stop it.
            return WizardResult.not_applicable(
                f"{self.name or 'This wizard'} is run by its agent from where it is "
                "offered, not from here — it needs the caller's request to do anything."
            )
        if not (approved or self.is_system()):
            return wizard_refused(self.name)
        return await execute_wizard(
            str(self.id), spec, self.asset_ref or "",
            trusted=True, approved=approved,
            subject_entity=None if unattended else str(self.typeid),
        )

    @action.post(action_name="run")
    async def run_action(self) -> ApiResponse:
        """`POST /wizard/<id>/run` — execute this wizard to completion.

        The trust gate REFUSES; it never blocks. A non-system wizard needs
        ``approved: true`` in the body, which the UI supplies after a confirm
        dialog. Modelling approval as a run the caller waits on is the shape that
        hangs a headless run forever, so an unattended caller gets an immediate,
        legible refusal instead.

        The body of EVERY answer is the ``WizardResult``, with a 200 — the exit
        code is the answer, and a caller reads it from one place, exactly as
        ``POST /compute_op/<id>/run`` does. The one exception is ``busy``: the
        slot is held by another run, which is HTTP's own 409 and the one case a
        caller should simply retry. Disabled, conversational and unapproved are
        answers (``REFUSED`` / ``NOT_APPLICABLE``), decided in ``run`` so a
        trigger meets them too.
        """
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.core.wizard.state import is_approved, record_approval  # noqa: PLC0415

        approved = False
        if not self.is_system():
            request_info = get_current_request_info()
            body = await request_info.get_post_data() if request_info else {}
            # Recorded on a previous run, or carried by this POST — recorded
            # once, the first time, rather than rewritten on every run.
            approved = is_approved(str(self.id))
            if not approved and (body or {}).get("approved") is True:
                record_approval(str(self.id))
                approved = True

        result = await self.run(approved=approved)
        payload = result.model_dump(mode="json")
        if result.busy:
            return ApiFailResponse(message=result.detail, status_code=409, data=payload)
        return ApiSuccessResponse(data=payload)

    @action.post(action_name="validate")
    async def validate_action(self) -> ApiResponse:
        """`POST /wizard/<id>/validate` — is this document legal?

        The body carries the CANDIDATE document, so an editor can ask before the
        bytes hit disk; an empty body validates what is on disk. Either way the
        answer is **always 200** with the verdict in the payload. `Mcp.test_action`
        established the rule — a driver must not 500 the button — and there is a
        second reason here: a non-2xx makes the editor read its error list out of
        a thrown axios exception, which is where error lists go to be lost.
        """
        from pydantic import ValidationError  # noqa: PLC0415

        from flow_sdk.assets.types.wizard import WIZARD_JSON, document_warnings, parse_wizard
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
        from flow_sdk.schema.data_spec.wizard_spec import (  # noqa: PLC0415
            WizardIssueSpec,
            WizardSpec,  # noqa: PLC0415
            WizardValidationSpec,
        )

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}

        read_only = self.is_system()
        reason = (
            "This wizard ships with Flowpad. It is trusted to run commands without asking, "
            "and an upgrade would overwrite the edit."
            if read_only else ""
        )

        # A candidate arrives as a PARSED dict, so it is validated as one —
        # re-serializing it just to re-parse would cost a JSON round trip on
        # every blur. Only the disk branch has text to begin with.
        candidate = (body or {}).get("document")
        issues: list[WizardIssueSpec] = []
        try:
            if candidate is not None:
                spec = WizardSpec.model_validate(candidate)
            else:
                try:
                    text = (Path(self.asset_ref) / WIZARD_JSON).read_text(encoding="utf-8")
                except OSError as exc:
                    return ApiSuccessResponse(data=WizardValidationSpec(
                        ok=False,
                        issues=[WizardIssueSpec(msg=f"{WIZARD_JSON} could not be read: {exc}")],
                        read_only=read_only, read_only_reason=reason,
                    ).model_dump())
                spec = parse_wizard(text)
        except ValidationError as exc:
            issues = [
                WizardIssueSpec(
                    loc=[part for part in err.get("loc", ()) if isinstance(part, (str, int))],
                    msg=err.get("msg", "is invalid"),
                    type=err.get("type", ""),
                )
                for err in exc.errors(include_url=False)
            ]
        except ValueError as exc:
            issues = [WizardIssueSpec(msg=f"Invalid JSON: {exc}")]
        else:
            issues = document_warnings(spec)

        return ApiSuccessResponse(data=WizardValidationSpec(
            ok=not any(issue.severity == "error" for issue in issues),
            issues=issues,
            read_only=read_only,
            read_only_reason=reason,
        ).model_dump())

    @action.post(action_name="reset")
    async def reset_action(self) -> ApiResponse:
        """`POST /wizard/<id>/reset` — archive this run and start the record fresh.

        Refuses with 409 while a run holds the wizard's lock: a reset landing
        mid-run would have the runner write its outcomes into the record we just
        cleared. The activity tree is deliberately untouched — `Activity.get` is
        find-or-CREATE, so "resetting" a settled run would fabricate a phantom
        pending root in the footer chip.
        """
        from flow_sdk.core.wizard.state import reset_run  # noqa: PLC0415

        fresh = reset_run(str(self.id))
        if fresh is None:
            return ApiFailResponse(
                message=f"{self.name or 'This wizard'} is running; stop it before resetting.",
                status_code=409,
            )
        return ApiSuccessResponse(data=fresh)

    @action.get(action_name="run-detail")
    async def run_detail_action(self) -> ApiResponse:
        """`GET /wizard/<id>/run-detail` — the last ``WizardResult`` WITH every
        step's output.

        The only place step output is served. `run_state` strips it because it
        rides every row of a list and every WS push; a person debugging one
        wizard asks for it here.
        """
        from flow_sdk.core.wizard.state import archived_runs, read_result  # noqa: PLC0415
        from flow_sdk.schema.data_spec.wizard_spec import WizardRunDetailSpec  # noqa: PLC0415

        detail = WizardRunDetailSpec(result=read_result(str(self.id)), archived=archived_runs(str(self.id)))
        return ApiSuccessResponse(data=detail.model_dump(mode="json"))
