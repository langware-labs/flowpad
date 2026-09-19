"""ComputeOp — a folder-backed CALL: the row and its two verbs.

Folder layout::

    <scope>/agentic-assets/compute_op/<name>/
        compute_op.json     # the check, the attempts, what it requires, what it returns
        setup.md            # how a person does it by hand

Disk is the truth for what an op DOES; the row carries what a list needs and
``spec()`` re-reads the document, so editing the json changes behaviour with no
re-save — the same contract the Wizard keeps.

This module owns the three things the pure runner deliberately does not: lookup
(``requires`` resolution), the Activity node, and the trust decision. The state
machine itself is ``flow_sdk/core/compute_op/runner.py`` and has no I/O, which is
what lets the whole block be driven in a REPL and inside a container with nothing
indexed.
"""
import logging
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Optional

from pydantic import computed_field

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity, action
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec import SpecType
from flow_sdk.schema.data_spec.compute_op_spec import AttemptSpec, CommandSpec
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.compute_op_spec import CheckOutcome, ComputeOpSpec
    from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue

logger = logging.getLogger(__name__)

#: The op's body file, and therefore the spec field it fills.
BODY_FIELD = "setup"
#: The main document. ``asset_ref`` is the FOLDER, so every read joins this.
MAIN = "compute_op.json"


class ComputeOp(Entity):
    """The row mirrors the document, field for field — the standard for an entity
    document, and what ``check_asset_spec`` enforces at registration.

    It is an INDEX, not the truth: ``spec()`` re-reads the file, so editing
    ``compute_op.json`` changes behaviour with no re-save.
    """

    type: str = APIField(default=EntityType.COMPUTE_OP.value)
    name: str = APIField(default="")
    label: str = APIField(default="", description="What a person calls this goal.")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    requires: list[str] = APIField(default_factory=list, description="Goals that must hold first.")
    completion_check: Optional[CommandSpec] = APIField(default=None, description="When this op is already done; absent means it always runs.")
    not_applicable_codes: list[int] = APIField(default_factory=list, description="Completion-check exit codes that mean \"not this machine\".")
    attempts: list[AttemptSpec] = APIField(default_factory=list, description="Ordered cheapest-first: command, prompt, agent.")
    output: Optional[SpecType] = APIField(default=None, description="The shape this op returns.")
    setup: str = APIField(default="", description="How a person does this by hand (setup.md).")

    _api_visible: ClassVar[bool] = True

    @classmethod
    async def by_name(cls, name: str) -> Optional["ComputeOp"]:
        """The op named ``name``, or None. Names are the handle ``requires`` uses."""
        return await cls.get_one({"name": name})

    def spec(self) -> Optional["ComputeOpSpec"]:
        """The parsed document — disk is truth, through the generic entity-document
        reader. ``None`` when it is missing or malformed."""
        from flow_sdk.assets.entity_document import read_entity_document  # noqa: PLC0415
        from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec  # noqa: PLC0415

        if not self.asset_ref:
            return None
        # ``asset_ref`` is the folder; the reader wants the main document inside it.
        main = Path(self.asset_ref)
        if main.is_dir():
            main = main / MAIN
        try:
            document = read_entity_document(main)
            return ComputeOpSpec.model_validate({**document.fields, BODY_FIELD: document.body})
        except Exception as error:  # a bad document is "no op here", never a wedged caller
            logger.warning("compute_op %s is unreadable: %s", self.name or self.asset_ref, error)
            return None

    def is_system(self) -> bool:
        """True when this op ships inside an SDK system project.

        THE trust boundary, and the same rule the Wizard keeps: systemness is a
        property of the LOCATION. A shipped op's commands are ours and run
        unprompted; anything else arrived in a repo someone cloned, and running
        its shell one-liners unasked would make "open a project" a
        code-execution primitive.
        """
        from flow_sdk.config import is_system_project_path  # noqa: PLC0415

        if not self.asset_ref:
            return False
        return any(is_system_project_path(p) for p in Path(self.asset_ref).parents)

    @computed_field
    @property
    def shipped(self) -> bool:
        """The trust answer on the wire — ``is_system()`` is a method and never reaches the UI."""
        return self.is_system()

    async def _resolver(self):
        """Resolve a ``requires`` name to its spec. This is the lookup the pure
        runner refuses to know how to do."""
        async def resolve(name: str):
            row = await ComputeOp.by_name(name)
            return row.spec() if row is not None else None

        return resolve

    async def check(self, *, platform: str = "") -> "CheckOutcome":
        """Ask this op's question. Cheap, side-effect free, safe on a schedule —
        which is how an expired value gets noticed with nobody at the keyboard.

        The verb is ``check`` on every surface; the NOUN it asks is ``question``.
        They cannot share a name in Python, and a field and a method that did
        would shadow each other silently.
        """
        from flow_sdk.core.compute_op import check_op  # noqa: PLC0415

        spec = self.spec()
        if spec is None:
            # NOT "not applicable": a document we cannot read is a broken op, and
            # reporting it as a clean skip is how a goal nobody ever checked comes
            # back as one that passed.
            raise ValueError(f"{self.name or self.asset_ref}: the document is missing or unreadable.")
        return await check_op(spec, platform=platform)

    async def run(
        self,
        *,
        subject: str = "",
        approved: bool = False,
        workdir: Optional[Path] = None,
        parent: "object | None" = None,
    ) -> "ReturnedValue":
        """Reach the goal, or produce the value, or say what is missing.

        Reports into ``parent`` when a caller passes its Activity node (a wizard
        step), so a nested run is ONE tree rather than a second root. Otherwise it
        claims its own address — suffixed with a run id, because the address is a
        slot and two callers of one op would otherwise collide on it.
        """
        from flow_sdk.activity import Activity  # noqa: PLC0415
        from flow_sdk.core.compute_op import ComputeOpNotApproved, run_op  # noqa: PLC0415
        from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue  # noqa: PLC0415

        spec = self.spec()
        if spec is None:
            return ReturnedValue(
                exit_code=ExitCode.NOT_FOUND,
                detail=f"{self.name}: the document is missing or unreadable.",
                pending=(self.name,),
            )
        trusted = approved or self.is_system()
        if not trusted:
            # Refuse, never block: a headless caller gets a legible answer
            # rather than a run that waits forever for a decision.
            raise ComputeOpNotApproved(
                f"{spec.display_label} runs on this machine. Approve it to run it."
            )

        async def go(node) -> "ReturnedValue":
            node.label(spec.display_label)
            answer = await run_op(
                spec, subject=subject or str(self.typeid), trusted=True,
                workdir=workdir, resolve=await self._resolver(),
                on_status=lambda text: node.current(text),
            )
            node.current(answer.detail)
            return answer

        if parent is not None:
            return await go(parent)
        address = f"compute_op/{self.name or self.id}-{uuid.uuid4().hex[:6]}"
        async with Activity.claim(address, subject_entity=str(self.typeid), queue=False) as root:
            return await go(root)

    @action.get(action_name="check")
    async def check_action(self) -> ApiResponse:
        """``GET /compute_op/<id>/check`` — ask, change nothing."""
        try:
            outcome = await self.check()
        except ValueError as bad_document:
            return ApiFailResponse(message=str(bad_document), status_code=400)
        return ApiSuccessResponse(data={"outcome": str(outcome)})

    @action.post(action_name="run")
    async def run_action(self, approved: bool = False) -> ApiResponse:
        """``POST /compute_op/<id>/run`` — ask, act, prove.

        The trust gate REFUSES rather than parking: an op the caller may not run
        answers 403 now instead of becoming a process nobody ever answers.
        """
        from flow_sdk.core.compute_op import ComputeOpNotApproved  # noqa: PLC0415

        try:
            answer = await self.run(approved=approved)
        except ComputeOpNotApproved as refusal:
            return ApiFailResponse(message=str(refusal), status_code=403)
        except ValueError as bad_document:  # a requires cycle
            return ApiFailResponse(message=str(bad_document), status_code=400)
        return ApiSuccessResponse(data=answer.model_dump(mode="json"))
