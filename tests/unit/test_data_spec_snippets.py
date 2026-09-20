"""The snippets in ``docs/snippets/data-spec.md``, run verbatim.

A snippet nobody executes drifts the moment a signature moves. Each pin reads the
``.md`` and runs the fence that declares the shape; the usage fence beneath it is
a reader's transcript — every line it claims is asserted here.
"""
from __future__ import annotations

import sys
import types
from typing import Any, ClassVar

import pytest
from pydantic import ValidationError
from pydantic.errors import PydanticUserError

from flow_sdk.schema.data_spec import DataSpec, to_authoring_form
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from tests.utils.snippets import doc, fence_under, run_fence

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

PAGE = "data-spec.md"


def _namespace(**names) -> dict:
    """A fence's namespace, backed by a REAL module.

    A fence that declares one shape inside another leaves pydantic a forward
    reference, and pydantic resolves it through ``sys.modules[cls.__module__]``.
    A bare dict has no module, so the nested shape never resolves — the reader's
    own file would have had one, so the pin gives the fence the same.
    """
    module = types.ModuleType("_data_spec_snippets")
    sys.modules[module.__name__] = module
    module.__dict__.update(DataSpec=DataSpec, ClassVar=ClassVar, **names)
    return module.__dict__


async def _shape(heading: str, name: str) -> type:
    """The class the first fence under *heading* declares."""
    ns = _namespace()
    await run_fence(fence_under(doc(PAGE), heading), ns, filename=f"{PAGE}#{heading}")
    return ns[name]


# ── §1. Declare a shape ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_snippet_1_the_instance_is_the_data():
    Endpoint = await _shape("1.", "Endpoint")
    assert Endpoint(port=8099).model_dump() == {"host": "localhost", "port": 8099}


@pytest.mark.asyncio
async def test_snippet_1_what_the_shape_refuses():
    Endpoint = await _shape("1.", "Endpoint")
    with pytest.raises(ValidationError, match="port"):
        Endpoint(port="nope")
    with pytest.raises(ValidationError, match="prot"):
        Endpoint(port=1, prot=2)       # extra="forbid"
    with pytest.raises(ValidationError):
        Endpoint(port=1).port = 2      # frozen


@pytest.mark.asyncio
async def test_snippet_1_a_changed_value_leaves_the_original_alone():
    Endpoint = await _shape("1.", "Endpoint")
    spec = Endpoint(port=1)
    assert spec.model_copy(update={"port": 2}).port == 2
    assert spec.port == 1


# ── §2. A shape written in a document ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_snippet_2_a_document_shape_compiles_and_round_trips():
    ns = _namespace(to_authoring_form=to_authoring_form)
    await run_fence(fence_under(doc(PAGE), "2."), ns, filename=f"{PAGE}#2")
    Endpoint = ns["Endpoint"]
    assert Endpoint(host="h", port=8099).model_dump() == {"host": "h", "port": 8099}
    assert to_authoring_form(Endpoint) == {"host": "string", "port": "int"}


@pytest.mark.asyncio
async def test_snippet_2_the_three_forms():
    assert DataSpec.parse("int") is int
    assert DataSpec.parse(["int"]) == list[int]
    with pytest.raises(ValueError, match="exactly one element"):
        DataSpec.parse({"ports": ["int", "int"]})


@pytest.mark.asyncio
async def test_snippet_2_identical_forms_share_one_anonymous_class():
    form = {"host": "string", "port": "int"}
    assert DataSpec.parse(form) is DataSpec.parse(dict(form))
    assert DataSpec.parse(form).__name__.startswith("Spec_")


@pytest.mark.asyncio
async def test_snippet_2_an_unregistered_kind_resolves_to_Any_silently():
    """The page's warning. An UNREGISTERED name stays ``Any`` by design —
    eager compilation of forward references depends on it (``_kinds.py``). A
    registered type with no document shape is the case that now raises."""
    assert DataSpec.parse("nope.not.registered") is Any


@pytest.mark.asyncio
async def test_snippet_2_a_named_shape_comes_back_as_your_class():
    """§2's naming fence: a declared kind is what makes `parse` answer YOUR
    class instead of an anonymous compiled one."""
    ns = _namespace(to_authoring_form=to_authoring_form)
    for nth in (3, 4):   # the class, then what `parse` answers for its kind
        await run_fence(fence_under(doc(PAGE), "2.", nth=nth), ns, filename=f"{PAGE}#2[{nth}]")
    assert DataSpec.parse("demo.endpoint") is ns["Endpoint"]
    assert to_authoring_form(ns["Endpoint"]) == "demo.endpoint"


# ── §3. What a call returns ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_snippet_3_a_call_answers_one_shape():
    ns = _namespace(ReturnedValue=ReturnedValue, ExitCode=ExitCode)
    await run_fence(fence_under(doc(PAGE), "3."), ns, filename=f"{PAGE}#3")
    answer = ns["answer"]
    assert (answer.exit_code, answer.value, answer.detail) == (ExitCode.OK, 8099, "bound :8099")
    assert answer.ok


@pytest.mark.asyncio
async def test_snippet_3_the_exit_codes_are_what_the_cli_exits_with():
    """The page lists the values; `flow op` must agree with them."""
    from flow_sdk.cli.commands import op_cmd

    assert (int(ExitCode.OK), int(ExitCode.NOT_YET)) == (0, 1)
    assert (int(ExitCode.NOT_APPLICABLE), int(ExitCode.NOT_FOUND), int(ExitCode.REFUSED)) == (3, 4, 7)
    assert op_cmd.EXIT_NOT_YET == int(ExitCode.NOT_YET)
    assert op_cmd.EXIT_NOT_FOUND == int(ExitCode.NOT_FOUND)


# ── §4. Save and load ─────────────────────────────────────────────────────────

async def _chain() -> tuple[dict, object]:
    """The shapes §4 declares, and the mixed value its second fence builds."""
    ns = _namespace()
    await run_fence(fence_under(doc(PAGE), "4.", nth=0), ns, filename=f"{PAGE}#4[0]")
    chain = ns["Toolchain"](
        name="dev",
        default=ns["Endpoint"](port=8080),
        ops=[ns["Op"](name="pick-port", steps=[
            ns["Step"](name="probe", setup="lsof -i", endpoint=ns["Endpoint"](port=9000))
        ])],
    )
    return ns, chain


@pytest.mark.asyncio
async def test_snippet_4_the_shapes_nest_three_levels_and_mix_kinds():
    """A shape inline, a list of shapes as a folder — at every level."""
    _, chain = await _chain()
    assert chain.default.port == 8080                          # inline at level 1
    assert chain.ops[0].steps[0].endpoint.port == 9000         # inline at level 3
    assert chain.ops[0].steps[0].setup == "lsof -i"


@pytest.mark.asyncio
async def test_snippet_4_save_writes_the_tree_the_page_shows(tmp_path):
    """A list of shapes is a directory; a shape is an object in its parent's json."""
    _, chain = await _chain()
    chain.save(tmp_path)
    # The identity carrier is §6's subject, not §4's — the page shows the
    # placement tree, and a capsule in every listing would bury it.
    written = sorted(
        p.relative_to(tmp_path).as_posix()
        for p in tmp_path.rglob("*")
        if p.is_file() and ".flow/" not in p.relative_to(tmp_path).as_posix()
    )
    assert written == [
        "ops/pick-port/op.json",
        "ops/pick-port/steps/probe/step.json",
        "toolchain.json",
    ], "an inline shape must NOT get a folder of its own"


@pytest.mark.asyncio
async def test_snippet_4_load_is_identity_three_levels_down(tmp_path):
    """Round trip is IDENTITY. A `write→read` that changes the value is the defect
    the dataset layout already has (cleanup J2) — this contract refuses it."""
    ns, chain = await _chain()
    chain.save(tmp_path)
    back = ns["Toolchain"].load(tmp_path)
    assert back == chain
    assert back.default.port == 8080
    assert back.ops[0].steps[0].endpoint.port == 9000


# ── §5. A field that is a file (TARGET — native types not implemented) ────────

@pytest.mark.asyncio
async def test_snippet_5_a_file_backed_field_is_read_off_the_type():
    from flow_sdk.schema.data_spec.io import Binary, Text

    ns = _namespace(Text=Text, Binary=Binary)
    await run_fence(fence_under(doc(PAGE), "5.", nth=0), ns, filename=f"{PAGE}#5[0]")
    op = ns["Op"](name="n", setup="hello")
    assert op.setup.upper() == "HELLO", "a Text IS a str"


@pytest.mark.asyncio
async def test_snippet_5_a_text_field_becomes_its_own_file(tmp_path):
    """The page's table: `Text` -> `<field>.md`, and several per shape."""
    from flow_sdk.schema.data_spec.io import Binary, Text

    ns = _namespace(Text=Text, Binary=Binary)
    await run_fence(fence_under(doc(PAGE), "5.", nth=0), ns, filename=f"{PAGE}#5[0]")
    op = ns["Op"](name="pick-port", setup="Run `lsof -i`.", readme="hi", icon=b"\x89PNG")
    op.save(tmp_path)
    written = {p.name for p in tmp_path.rglob("*") if p.is_file()}
    assert {"op.json", "setup.md", "readme.md", "icon.bin"} <= written
    assert ns["Op"].load(tmp_path) == op


def test_the_native_type_mechanism_the_page_depends_on_is_sound():
    """§5's design, proven on a prototype: a ``str`` subclass registered as a
    grammar primitive keeps ``str`` behaviour AND names itself in the authoring
    form. This is what makes `markdown` a type rather than a marker on `str`,
    so a shape may carry several (which ``Body`` forbids — cleanup H2).
    """
    from pydantic_core import core_schema

    from flow_sdk.schema.data_spec import _kinds

    class Markdown(str):
        @classmethod
        def __get_pydantic_core_schema__(cls, source, handler):
            return core_schema.no_info_after_validator_function(cls, core_schema.str_schema())

    _kinds.PRIMITIVES["markdown"] = Markdown
    _kinds.PRIMITIVE_NAMES[Markdown] = "markdown"
    try:
        class Op(DataSpec):
            name: str
            setup: Markdown = Markdown("")
            readme: Markdown = Markdown("")      # several per shape

        op = Op(name="pick-port", setup="Run `lsof -i`.")
        assert to_authoring_form(Op) == {"name": "string", "setup": "markdown", "readme": "markdown"}
        assert isinstance(op.setup, str) and op.setup.upper() == "RUN `LSOF -I`."
        assert op.model_dump()["setup"] == "Run `lsof -i`."
        assert DataSpec.parse({"setup": "markdown"}).model_fields["setup"].annotation is Markdown
    finally:
        _kinds.PRIMITIVES.pop("markdown", None)
        _kinds.PRIMITIVE_NAMES.pop(Markdown, None)


@pytest.mark.asyncio
async def test_snippet_3_a_declared_output_is_enforced_not_suggested(tmp_path):
    """§3's declaration lines: the shape a callee declares is checked, and a
    mismatch FAILS. Seam-injected, so no process and no DB are involved."""
    import json

    from flow_sdk.core.compute.exec import ShellResult
    from flow_sdk.core.compute.process_step import ProcessResult
    from flow_sdk.core.compute.receipt import receipt_path
    from flow_sdk.core.compute_op import run_op
    from flow_sdk.core.compute_op.runner import VALUE_KEY
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec

    op = ComputeOpSpec.model_validate({
        "name": "pick-port",
        "output": {"host": "string", "port": "int"},
        "attempts": [{"kind": "agent", "agent": "capability-installer", "prompt": "p"}],
    })

    def returning(value):
        async def launch(*, workdir, **_kw):
            path = receipt_path(workdir, "pick-port")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"status": "done", "data": {VALUE_KEY: value}}))
            return ProcessResult(process_id="p1", ok=True, message="agent finished")
        return launch

    async def shell(_command, **_kw):
        return ShellResult(returncode=0)

    good = await run_op(op, trusted=True, workdir=tmp_path, platform="linux",
                        shell=shell, launch=returning({"host": "localhost", "port": 8099}))
    assert good.exit_code is ExitCode.OK and good.value.port == 8099

    bad = await run_op(op, trusted=True, workdir=tmp_path, platform="linux",
                       shell=shell, launch=returning({"host": "h", "port": "nope"}))
    assert bad.exit_code is ExitCode.NOT_YET and not bad.ok
    assert "declared output" in bad.detail


# ── §6. Identity ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_snippet_6_a_shape_declares_no_id():
    """The page's claim, checked against every asset document spec in the tree:
    identity is a carrier, so no content spec may declare an `id` field."""
    from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec

    def every_subclass(cls):
        for sub in cls.__subclasses__():
            yield sub
            yield from every_subclass(sub)

    offenders = [s.__name__ for s in every_subclass(AssetDocumentSpec) if "id" in s.model_fields]
    assert not offenders, f"identity is a carrier, not content: {offenders}"


def test_snippet_6_an_adopted_id_must_validate():
    """"adopted only if it validates" — the gate the page describes."""
    from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid

    assert is_valid_entity_id(str(mint_uuid()))                       # v4, freshly minted
    assert is_valid_entity_id("e3b0c442-98fc-4f2b-9e1a-2d4c6b8a0f31")  # v4
    assert not is_valid_entity_id("0192f8c1-7e3a-7c4d-8b21-5f6a7b8c9d0e")  # v7 — refused
    assert not is_valid_entity_id("pick-port")                         # a slug is not an id


@pytest.mark.asyncio
async def test_snippet_6_the_identity_fence_declares_a_real_shape():
    """§6's fence went unexecuted and drifted — it declared a `Markdown` type
    that does not exist. Running it is what keeps the page honest."""
    from flow_sdk.schema.data_spec.io import Text

    ns = _namespace(Text=Text)
    await run_fence(fence_under(doc(PAGE), "6."), ns, filename=f"{PAGE}#6")
    assert ns["Op"](name="n", setup="hello").setup == "hello"
