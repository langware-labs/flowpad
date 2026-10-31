"""ComputeOp — a folder-backed CALL: the row and its two verbs.

Folder layout::

    <scope>/agentic-assets/compute_op/<name>/
        compute_op.json     # the subkind, its exe_data, the check, what it returns
        setup.md            # how a person does it by hand

Disk is the truth for what an op DOES; the row carries what a list needs and
``spec()`` re-reads the document, so editing the json changes behaviour with no
re-save — the same contract the Wizard keeps.

This module owns the two things the pure runner deliberately does not: the
Activity node, and the trust decision. The state
machine itself is ``flow_sdk/core/compute_op/runner.py`` and has no I/O, which is
what lets the whole block be driven in a REPL and inside a container with nothing
indexed.
"""

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, ClassVar, Optional, Union

from pydantic import computed_field, model_validator

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core import Entity, action
from flow_sdk.core.compute.declared_value import MISSING, DeclaredShapeError
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec._form import ShapeForm
from flow_sdk.schema.data_spec.compute_call_spec import CallRecord
from flow_sdk.schema.data_spec.compute_op_spec import (
    AgentOp,
    AskOp,
    CallLogSpec,
    CliOp,
    DecisionOp,
    NavigateOp,
    OpSubkind,
    PromptOp,
    PythonOp,
    Rung,
    exe_data_by_subkind,
)
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ReturnedValue

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
    subkind: OpSubkind = APIField(default=OpSubkind.CLI, description="Who does the work: navigate, cli, decision, prompt, agent or ask.")
    exe_data: Union[NavigateOp, CliOp, PythonOp, DecisionOp, PromptOp, AgentOp, AskOp] = APIField(
        default=None, description="The one call, shaped by the subkind."
    )
    output_spec_kind: Optional[str] = APIField(default=None, description="The kind this op returns.")
    input: Optional[ShapeForm] = APIField(default=None, description="Declared input shape.")
    output: Optional[ShapeForm] = APIField(default=None, description="Declared output shape.")
    completion_check: Optional[CliOp] = APIField(
        default=None, description="When this op is already done; absent means it always runs."
    )
    status_check: Optional[str] = APIField(
        default=None, description="The completion check as a status fact (install:<harness>), answered in-process."
    )
    isolated_shell: bool = APIField(
        default=False, description="Run in a shell of its own instead of the run's shared one."
    )
    attempts: list[Rung] = APIField(
        default_factory=list, description="Further rungs (cli/prompt/agent) tried in order at the same goal."
    )
    not_applicable_codes: list[int] = APIField(
        default_factory=list, description='Completion-check exit codes that mean "not this machine".'
    )
    setup: str = APIField(default="", description="How a person does this by hand (setup.md).")
    setup_timeout_seconds: Optional[float] = APIField(
        default=None, description="How long an agent following setup gets (AI Assist); unset = the default."
    )
    log: Optional[CallLogSpec] = APIField(
        default=None, description="Log every call as a dataset row in temp, with its run's trace."
    )

    _api_visible: ClassVar[bool] = True

    @model_validator(mode="before")
    @classmethod
    def _exe_data_is_its_subkinds(cls, data):
        """The row reads ``exe_data`` exactly as the document does — by ``subkind``."""
        return exe_data_by_subkind(data)

    @classmethod
    async def by_name(cls, name: str) -> Optional["ComputeOp"]:
        """The op named ``name``, or None — this install's copy when a project shadows it."""
        from flow_sdk.builtin.shipped_lookup import by_name_preferring_this_install  # noqa: PLC0415

        return await by_name_preferring_this_install(cls, name)

    @classmethod
    async def resolve(cls, ref: str, *, project: str | None = None) -> Optional["ComputeOp"]:
        """An exact TypeId or unique project-scoped name; never first-match routing."""
        prefix = EntityType.COMPUTE_OP.value + "-"
        if ref.startswith(prefix):
            return await cls.get_by_id(ref[len(prefix):])
        filters = {"name": ref}
        if project:
            filters["project_id"] = project.removeprefix(EntityType.PROJECT.value + "-")
        rows = await cls.get_all(filters)
        if len(rows) > 1:
            raise DeclaredShapeError(f"Ambiguous compute op {ref!r}; choose its TypeId or project")
        return rows[0] if rows else None

    @computed_field
    @property
    def durable_calls_supported(self) -> bool:
        """Runtime capability; older servers omit it rather than implying support."""
        return True

    @computed_field
    @property
    def input_shape(self) -> Any:
        return self.input

    @computed_field
    @property
    def output_shape(self) -> Any:
        return self.output if self.output is not None else self.output_spec_kind

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

    async def check(self, *, platform: str = "") -> "CliResult":
        """Ask this op's question. Cheap, side-effect free, safe on a schedule —
        which is how an expired value gets noticed with nobody at the keyboard.

        The verb is ``check`` on every surface; the NOUN it asks is the
        ``completion_check``. They cannot share a name in Python, and a field
        and a method that did would shadow each other silently.
        """
        from flow_sdk.core.compute_op import check_op  # noqa: PLC0415
        from flow_sdk.schema.data_spec.returned_value_spec import CliResult  # noqa: PLC0415

        spec = self.spec()
        if spec is None:
            # NOT "not applicable": a document we cannot read is a broken op, and
            # reporting it as a clean skip is how a goal nobody ever checked comes
            # back as one that passed.
            return CliResult.not_found(f"{self.name or self.asset_ref}: the document is missing or unreadable.")
        return await check_op(spec, platform=platform)

    async def run(
        self,
        *,
        subject: str = "",
        approved: bool = False,
        workdir: Optional[Path] = None,
        parent: "object | None" = None,
        input: Any = MISSING,
        invocation_id: str | None = None,
        call_id: str | None = None,
        parent_call_id: str | None = None,
        on_executor: Callable[[str], None] | None = None,
    ) -> "ReturnedValue":
        """Reach the goal, produce the value, or say what is missing.

        Expected outcomes are returned; invalid input and execution errors raise.

        An op this instance does not ship, run without approval, answers
        ``REFUSED`` — refused, never blocked: a headless caller gets a legible
        answer rather than a run that waits forever for a decision.

        Reports into ``parent`` when a caller passes its Activity node (a wizard
        step), so a nested run is ONE tree rather than a second root. Otherwise it
        claims its own address — suffixed with a run id, because the address is a
        slot and two callers of one op would otherwise collide on it.
        """
        from flow_sdk.activity import Activity  # noqa: PLC0415
        from flow_sdk.core.compute_op import run_op  # noqa: PLC0415
        from flow_sdk.core.compute_op.context import CallContext  # noqa: PLC0415
        from flow_sdk.core.compute_op.runner import refused_for  # noqa: PLC0415
        from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue  # noqa: PLC0415

        spec = self.spec()
        if spec is None:
            return ReturnedValue.not_found(f"{self.name}: the document is missing or unreadable.")
        if not (approved or self.is_system()):
            return refused_for(spec)
        correlation = invocation_id or str(mint_uuid())

        async def go(node) -> "ReturnedValue":
            node.label(spec.display_label)
            answer = await run_op(
                spec,
                subject=subject or str(self.typeid),
                trusted=True,
                workdir=workdir,
                on_status=lambda text: node.current(text),
                input=input,
                call_id=call_id,
                context=CallContext(asset_folder=Path(self.asset_ref), workdir=workdir, project=self.project_id,
                                    invocation_id=correlation, parent_call_id=parent_call_id, parent=node,
                                    shipped=self.is_system(), on_executor=on_executor),
            )
            node.current(answer.detail)
            return answer

        if parent is not None:
            return await go(parent)
        address = f"compute_op/{self.name or self.id}-{correlation}"
        async with Activity.claim(address, subject_entity=str(self.typeid), queue=False) as root:
            return await go(root)

    async def call(self, *, input: Any = MISSING, approved: bool = False, subject: str = "",
                   workdir: Optional[Path] = None, parent: Any = None,
                   invocation_id: str | None = None, call_id: str | None = None,
                   parent_call_id: str | None = None,
                   on_executor: Callable[[str], None] | None = None) -> "ReturnedValue":
        """Call the same operation with a declared input; legacy run stays available."""
        return await self.run(input=input, approved=approved, subject=subject, workdir=workdir,
                              parent=parent, invocation_id=invocation_id, call_id=call_id,
                              parent_call_id=parent_call_id, on_executor=on_executor)

    @classmethod
    async def for_folder(cls, folder: "Path | str") -> "ComputeOp | None":
        """The indexed op whose block lives in ``folder`` -- the one this instance knows there."""
        here = Path(folder).resolve()
        rows = await cls.get_all({"name": here.name})
        return next((op for op in rows if op.asset_ref and Path(op.asset_ref).resolve() == here), None)

    def _calls_folder(self) -> Path:
        from flow_sdk.fs_store.record_paths import data_dir_for

        return data_dir_for(EntityType.COMPUTE_OP.value, self.id) / "calls"

    async def start(self, *, input: Any = MISSING, approved: bool = False,
                    invocation_id: str | None = None, parent_call_id: str | None = None) -> CallRecord:
        """Persist admission and run independently of the requesting connection.

        A caller's ``invocation_id`` joins its run (``parent_call_id`` names the calling call);
        without one, this call is a run's root.
        """
        from flow_sdk.core.compute_op import durable
        from flow_sdk.core.compute_op.runner import validate_call_input

        spec = self.spec()
        if spec is not None and (approved or self.is_system()):
            input = validate_call_input(spec, input)
        return durable.start(
            self._calls_folder(), block=str(self.typeid), project_id=self.project_id,
            input=None if input is MISSING else input, input_present=input is not MISSING,
            invocation_id=invocation_id, parent_call_id=parent_call_id,
            execute=lambda identity, attach: self.call(input=input, approved=approved,
                                                      invocation_id=invocation_id or identity, call_id=identity,
                                                      parent_call_id=parent_call_id, on_executor=attach),
        )

    async def get_call(self, call_id: str) -> CallRecord | None:
        """Retrieve this operation's answer without executing or replaying it."""
        from flow_sdk.core.compute_op.durable import read

        return read(self._calls_folder(), call_id)

    @action.post(action_name="start")
    async def start_action(self, approved: bool = False, input: Any = MISSING,
                           invocation_id: str | None = None, parent_call_id: str | None = None) -> ApiResponse:
        if (refused := _bad_trace(invocation_id, parent_call_id)) is not None:
            return refused
        try:
            record = await self.start(input=input, approved=approved,
                                      invocation_id=invocation_id, parent_call_id=parent_call_id)
        except DeclaredShapeError as exc:
            return ApiFailResponse(message=str(exc), status_code=422)
        return ApiSuccessResponse(data=record.model_dump(mode="json"))

    @action.get(action_name="get_call")
    async def get_call_action(self, call_id: str) -> ApiResponse:
        try:
            record = await self.get_call(call_id)
        except ValueError as exc:
            return ApiFailResponse(message=str(exc), status_code=422)
        if record is None:
            return ApiFailResponse(message="Call not found for this operation", status_code=404)
        return ApiSuccessResponse(data=record.model_dump(mode="json"))

    @action.get(action_name="check")
    async def check_action(self) -> ApiResponse:
        """``GET /compute_op/<id>/check`` — ask, change nothing. The check's
        ``CliResult``; its ``exit_code`` is the verdict."""
        return ApiSuccessResponse(data=(await self.check()).model_dump(mode="json"))

    @action.post(action_name="run")
    async def run_action(self, approved: bool = False, input: Any = MISSING, answer_tagged: bool = False,
                         invocation_id: str | None = None, parent_call_id: str | None = None) -> ApiResponse:
        """``POST /compute_op/<id>/run`` — ask, act, prove.

        Every answer is a 200 carrying the ``ReturnedValue``, REFUSED included:
        the exit code is the answer, and a caller reads it from one place.
        """
        if (refused := _bad_trace(invocation_id, parent_call_id)) is not None:
            return refused
        try:
            answer = await self.run(approved=approved, input=input,
                                    invocation_id=invocation_id, parent_call_id=parent_call_id)
        except DeclaredShapeError as exc:
            return ApiFailResponse(message=str(exc), status_code=422)
        if answer_tagged or input is not MISSING or self.input is not None or self.output is not None or self.subkind is OpSubkind.PYTHON:
            from pydantic import TypeAdapter  # noqa: PLC0415

            from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue  # noqa: PLC0415
            from flow_sdk.schema.data_spec.spec import Tagged  # noqa: PLC0415

            return ApiSuccessResponse(data=TypeAdapter(Tagged[ReturnedValue]).dump_python(answer, mode="json"))
        return ApiSuccessResponse(data=answer.model_dump(mode="json"))


def _bad_trace(invocation_id: str | None, parent_call_id: str | None) -> ApiResponse | None:
    """A caller's trace ids are adopted only as entity UUIDs (the id policy's adopt gate)."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id  # noqa: PLC0415

    for name, value in (("invocation_id", invocation_id), ("parent_call_id", parent_call_id)):
        if value is not None and not is_valid_entity_id(value):
            return ApiFailResponse(message=f"{name} must be an entity UUID", status_code=422)
    return None
