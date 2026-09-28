"""Typed folder I/O for one agentic run: a DataSpec in, a DataSpec out.

A process works in one of two modes:

* **workdir** (the default) — the agent works on top of its ``workdir``. Nothing about output folders
  is said or read; the answer is the reply (``text``).
* **declared output** — the caller declares ``output_spec``. The agent is told the exact layout to write
  into ``<record>/execution/output`` (the files ``save`` writes for that DataSpec); after the turn
  ``load(output_spec, execution/output)`` reads it back into ``value``. A missing or invalid output is
  ``NOT_YET`` with the reason in ``detail`` — the rule every declared output follows
  (``blocks._AgentRunner._output``, the ComputeOp runner) — and the reply is kept in ``text``. A valid
  output's files are listed on the answer (``files``) and registered as the run's Artifacts: a declared
  output is a product of the run, saved as an entity.

Either mode may take an ``input``: ``save(input, execution/input)`` before the turn, the folder mounted
for the worker (``resolved_add_dirs``) and named in the instructions.

The layout is the DataSpec's own (``schema/data_spec/io``), so the class that declares the shape reads the
result: ``CVSpec.load(folder)`` and ``answer.value`` are the same value.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult

logger = logging.getLogger(__name__)

def input_dir(process: "AgenticProcess") -> Path:
    from flow_sdk.graph_workflow_manager.manager import execution_base  # noqa: PLC0415
    from flow_sdk.schema.data_spec.layout import INPUT  # noqa: PLC0415

    return execution_base(process) / INPUT


def output_dir(process: "AgenticProcess") -> Path:
    from flow_sdk.graph_workflow_manager.manager import execution_base  # noqa: PLC0415
    from flow_sdk.schema.data_spec.layout import OUTPUT  # noqa: PLC0415

    return execution_base(process) / OUTPUT


def declared_output_spec(shape: Any) -> Optional[type]:
    """An agent's declared ``output`` as a DataSpec class when it is one (a registered kind, an inline
    ``{field: shape}`` object), else ``None`` — a primitive (``"string"``) is a reply-text value, not a folder."""
    from flow_sdk.schema.data_spec import DataSpec  # noqa: PLC0415

    if shape is None:
        return None
    try:
        compiled = DataSpec.parse(shape)
    except Exception:  # noqa: BLE001 — a declaration that does not compile is not a folder contract
        return None
    return compiled if isinstance(compiled, type) and issubclass(compiled, DataSpec) else None


def check_declared_input(value: Any, shape: Any) -> None:
    """Refuse an ``input`` that does not satisfy the agent's declared ``input`` — before the run starts."""
    if value is None or shape is None:
        return
    from flow_sdk.core.compute.declared_value import to_declared  # noqa: PLC0415

    to_declared(value.model_dump(mode="json"), shape)


def resolve_output_spec(output_spec: Any) -> Optional[type]:
    """A DataSpec class, from the class itself or its registered kind name — or ``None``.

    An unknown name is refused HERE, before any process starts: resolving it lazily would let an
    agent do the whole job and then fail on a typo in the caller's code.
    """
    from flow_sdk.schema.data_spec import DataSpec  # noqa: PLC0415

    if output_spec is None:
        return None
    if isinstance(output_spec, type) and issubclass(output_spec, DataSpec):
        return output_spec
    if isinstance(output_spec, str):
        # ``parse`` answers ``Any`` for a name nobody registered — legal in a document, a typo here.
        resolved = DataSpec.parse(output_spec)
        if isinstance(resolved, type) and issubclass(resolved, DataSpec):
            return resolved
        raise ValueError(f"output_spec: unknown kind {output_spec!r} — no DataSpec is registered under that name")
    raise TypeError(f"output_spec must be a DataSpec class or a kind name, not {type(output_spec).__name__}")


def layout_of(spec: type) -> list[str]:
    """The files ``save`` writes for *spec*, one line each — what the agent is asked to produce."""
    from flow_sdk.schema.data_spec.io import names  # noqa: PLC0415
    from flow_sdk.schema.data_spec.io.placement import Placement, placements  # noqa: PLC0415

    inline = [n for n, p in placements(spec).items() if p in (Placement.INLINE, Placement.FREE_SECTION)]
    lines = [f"- `{names.main_document(spec)}` — JSON with the fields: {', '.join(inline) or '(none)'}"]
    for name, place in placements(spec).items():
        if place is Placement.BODY:
            lines.append(f"- `{names.field_file(name, '.md')}` — the `{name}` text (markdown)")
        elif place is Placement.DOCUMENT:
            lines.append(f"- `{names.field_file(name, '.md')}` — the `{name}` document")
        elif place is Placement.FILE_BYTES:
            lines.append(f"- `{name}.<ext>` — the `{name}` bytes")
        elif place in (Placement.DIR_LIST, Placement.DIR_DICT):
            lines.append(f"- `{name}/` — one folder per `{name}` entry, each in the same layout")
    return lines


def _document_schema(spec: type) -> dict:
    """The JSON schema of the main document only: fields that land in their own files (a ``Text``
    body, a nested document, a folder of entries) are described by the layout lines, not here."""
    from flow_sdk.schema.data_spec.io.placement import Placement, placements  # noqa: PLC0415

    schema = spec.model_json_schema()
    inline = {n for n, p in placements(spec).items() if p in (Placement.INLINE, Placement.FREE_SECTION)}
    schema["properties"] = {k: v for k, v in (schema.get("properties") or {}).items() if k in inline}
    if "required" in schema:
        schema["required"] = [k for k in schema["required"] if k in inline]
    return schema


def io_instructions(process: "AgenticProcess", *, has_input: bool, output_spec: Optional[type]) -> str:
    """What a run is told about its folders: the input folder when it has one, and — only when an output
    is declared — where and in which exact layout to write it. A workdir-mode run is told nothing."""
    parts: list[str] = []
    if has_input:
        parts.append(f"Your input is in: `{input_dir(process)}/` (read it from there).")
    if output_spec is not None:
        out = output_dir(process)
        schema = json.dumps(_document_schema(output_spec), separators=(",", ":"))
        parts.append(
            f"Your result MUST be a `{output_spec.__name__}` written into `{out}/` in exactly this layout:\n"
            + "\n".join(layout_of(output_spec))
            + f"\nThe JSON must validate against this schema (no other keys): {schema}"
        )
    return "\n\n".join(parts)


def prepare_io(process: "AgenticProcess", *, input: Any = None, output_spec: Optional[type] = None) -> None:
    """Materialize the run's folders and record what the agent is told about them. Before the turn.

    Workdir mode (no ``input``, no ``output_spec``) touches nothing. Otherwise a failure raises: the caller
    asked for that data. The block lands in ``context_data["io_instructions"]`` — its own part of the
    system prompt (``resolve_system_instructions``), never spliced into the caller's instructions.
    """
    from flow_sdk.schema.data_spec import DataSpec  # noqa: PLC0415
    from flow_sdk.schema.data_spec.io import save  # noqa: PLC0415

    if input is None and output_spec is None:
        return
    if input is not None:
        if not isinstance(input, DataSpec):
            raise TypeError(f"input must be a DataSpec instance, not {type(input).__name__}")
        save(input, input_dir(process))
    if output_spec is not None:
        output_dir(process).mkdir(parents=True, exist_ok=True)
    process.context_data = {
        **(process.context_data or {}),
        "io_instructions": io_instructions(process, has_input=input is not None, output_spec=output_spec),
    }


def output_files(process: "AgenticProcess") -> list[str]:
    """Every file the run left in its output folder, relative — the runs view's own listing."""
    from flow_sdk.graph_workflow_manager.manager import GraphWorkflowManager, execution_base  # noqa: PLC0415

    return GraphWorkflowManager._output_listing(execution_base(process))


async def register_outputs(process: "AgenticProcess", files: list[str]) -> None:
    """Each output file as an Artifact of this run — converging on a re-run (``Artifact.register``)."""
    if not files:
        return
    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415

    root = output_dir(process)
    try:
        project_id = await process.effective_project_id()
    except Exception:  # noqa: BLE001 — provenance is a courtesy; the run's answer does not depend on it
        project_id = None
    results = await asyncio.gather(*(
        Artifact.register(generated_by=str(process.typeid), name=Path(rel).name, kind="content.file",
                          asset_ref=str(root / rel), project_id=project_id)
        for rel in files
    ), return_exceptions=True)
    for rel, result in zip(files, results):
        if isinstance(result, Exception):  # a failed registration must not fail the run
            logger.debug("register_outputs: could not register %s: %s", rel, result)


async def take_turn(process: "AgenticProcess", prompt: str, output_spec: Optional[type], *, wait: bool = True) -> "PromptResult":
    """One headless turn: send it; with ``wait``, settle and read the output back. Without ``wait`` the
    answer is the admission (``send_turn``) — the turn has not finished."""
    from flow_sdk.builtin.agentic_process.agentic_process import _build_run_result  # noqa: PLC0415

    taken = await process.send_turn(prompt)
    if not taken.ok or not wait:
        return taken
    await process.wait()
    return await finish_io(process, _build_run_result(process), output_spec)


async def finish_io(process: "AgenticProcess", answer: "PromptResult", output_spec: Optional[type]) -> "PromptResult":
    """After the turn, in declared-output mode: hold ``value`` to ``output_spec``, list the output files and
    register them as the run's Artifacts. Workdir mode returns the answer as it is."""
    from flow_sdk.schema.data_spec.io import load  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode  # noqa: PLC0415

    if output_spec is None:
        return answer
    files = output_files(process)
    answer = answer.model_copy(update={"files": files})
    if not answer.ok:
        return answer
    try:
        value = load(output_spec, output_dir(process))
    except Exception as error:  # noqa: BLE001 — pydantic, a missing file and bad JSON all mean the same thing
        reason = str(error).splitlines()[0] if str(error) else type(error).__name__
        return answer.model_copy(update={
            "exit_code": ExitCode.NOT_YET,
            "detail": f"The output is not a valid {output_spec.__name__}: {reason}",
        })
    # Only a valid declared output is a product of the run; a failed one is evidence, kept in ``files``.
    await register_outputs(process, files)
    return answer.model_copy(update={"value": value})


__all__ = [
    "check_declared_input", "declared_output_spec", "finish_io", "input_dir", "output_dir", "prepare_io",
    "register_outputs", "resolve_output_spec", "take_turn",
]
