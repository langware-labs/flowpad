"""ComputeOp — a folder-backed GOAL: the row and its two verbs.

Folder layout::

    <scope>/agentic-assets/compute_op/<name>/
        compute_op.json     # the check, the attempts, what it requires
        setup.md            # how a person does it by hand

Disk is the truth for what an op DOES; the row carries what a list needs and
``spec()`` re-reads the document, so editing the json changes behaviour with no
re-save — the same contract the Wizard keeps.

This module owns the three things the pure runner deliberately does not: lookup
(``requires`` resolution), the Activity node, and the trust decision. The state
machine itself is ``flow_sdk/core/compute_op/runner.py`` and has no I/O, which
is what lets the whole block be driven in a REPL and inside a container with
nothing indexed.
"""
import logging
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar, Optional

from pydantic import computed_field

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity, action
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.compute_op_spec import AttemptSpec, CheckSpec
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.compute_op_spec import CheckOutcome, ComputeOpSpec

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
    icon: str = APIField(default="BadgeCheck")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    enabled: bool = APIField(default=True, description="The op's active switch.")
    requires: list[str] = APIField(default_factory=list, description="Goals that must hold first.")
    check: CheckSpec = APIField(default_factory=CheckSpec, description="The one question that decides whether the goal holds.")
    attempts: list[AttemptSpec] = APIField(default_factory=list, description="Ordered cheapest-first; the agent is the last rung.")
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

    async def ask(self, *, platform: str = "") -> "CheckOutcome":
        """Ask the question. Cheap, side-effect free, safe on a schedule — which
        is how an expired value gets noticed with nobody touching the machine.

        NOT called ``check``: that is the FIELD holding the question, and a method
        of the same name shadows it — ``self.check()`` then calls a ``CheckSpec``.
        The action, the route and ``flow op check`` all keep the word; only the
        Python method steps aside.
        """
        from flow_sdk.core.compute_op import check_op  # noqa: PLC0415

        spec = self.spec()
        if spec is None:
            # NOT "not applicable": a document we cannot read is a broken op, and
            # reporting it as a clean skip is how a goal nobody ever checked comes
            # back as one that passed.
            raise ValueError(f"{self.name or self.asset_ref}: the document is missing or unreadable.")
        return await check_op(spec, platform=platform)

    async def run(self, *, subject: str = "", approved: bool = False, workdir: Optional[Path] = None):
        """Make the goal hold, or say precisely what is still missing.

        Wrapped in ONE Activity claim for the whole run, with this op as the
        subject, so it appears in the same footer chip as an index walk.
        """
        from flow_sdk.activity import Activity  # noqa: PLC0415
        from flow_sdk.core.compute_op import ComputeOpNotApproved, run_op  # noqa: PLC0415
        from flow_sdk.sources.protocols import Verdict  # noqa: PLC0415

        spec = self.spec()
        if spec is None:
            return Verdict(ready=False, detail=f"{self.name}: the document is missing or unreadable.",
                           pending=(self.name,))
        trusted = approved or self.is_system()
        if not trusted:
            # Refuse, never block: a headless caller gets a legible answer
            # rather than a run that waits forever for a decision.
            raise ComputeOpNotApproved(
                f"{spec.display_label} runs commands on this machine. Approve it to run it."
            )

        async with Activity.claim(f"compute_op/{self.name}", subject_entity=str(self.typeid), queue=False) as root:
            root.label(spec.display_label).icon(spec.icon)
            verdict = await run_op(
                spec, subject=subject or str(self.typeid), trusted=True,
                workdir=workdir, resolve=await self._resolver(),
            )
            root.current(verdict.detail)
            return verdict

    @action.get(action_name="check")
    async def check_action(self) -> ApiResponse:
        """``GET /compute_op/<id>/check`` — ask, change nothing."""
        try:
            outcome = await self.ask()
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
            verdict = await self.run(approved=approved)
        except ComputeOpNotApproved as refusal:
            return ApiFailResponse(message=str(refusal), status_code=403)
        except ValueError as bad_document:  # a requires cycle
            return ApiFailResponse(message=str(bad_document), status_code=400)
        return ApiSuccessResponse(data=verdict.model_dump(mode="json"))
