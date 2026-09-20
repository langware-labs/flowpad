"""``load(save(x)) == x``, for every placement.

The contract §4 of ``docs/snippets/data-spec.md`` states, pinned case by case.
Identity is the whole point: the dataset layout it replaces wrote a ``FileRef``
and read back a ``FolderSpec``, and no test caught it because the writer and the
reader were each self-consistent. Here they walk one ``placements()`` table, and
this file is what proves they still agree.

Every case asserts the VALUE round-trips and, where the layout is the point,
the exact files on disk — a placement that quietly changed shape would pass an
equality check on a lenient spec.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import pytest

from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io import Text, load, save

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


class Endpoint(DataSpec):
    """A value: it rides inside its parent's json."""

    host: str = "localhost"
    port: int = 0


class Doc(DataSpec):
    """A document: it has content, so it is a file."""

    title: str = ""
    body: Text = Text("")


class Step(DataSpec):
    name: str
    setup: Doc = Doc()


class Everything(DataSpec):
    name: str
    count: int = 0
    maybe: Optional[str] = None
    endpoint: Endpoint = Endpoint()
    nested: Optional[Endpoint] = None
    doc: Doc = Doc()
    steps: list[Step] = []
    unnamed: list[Endpoint] = []
    by_key: dict[str, Endpoint] = {}
    env: dict[str, str] = {}


def _round_trip(value, tmp_path: Path):
    save(value, tmp_path)
    return load(type(value), tmp_path)


def test_a_scalar_survives(tmp_path):
    assert _round_trip(Endpoint(host="h", port=1), tmp_path) == Endpoint(host="h", port=1)


def test_an_absent_optional_stays_absent(tmp_path):
    """`None` must not come back as `""` — a lenient spec would hide that."""
    assert _round_trip(Everything(name="n"), tmp_path).maybe is None


def test_a_present_optional_survives(tmp_path):
    assert _round_trip(Everything(name="n", maybe="here"), tmp_path).maybe == "here"


def test_a_nested_value_rides_inline(tmp_path):
    value = Everything(name="n", endpoint=Endpoint(port=8099))
    assert _round_trip(value, tmp_path).endpoint.port == 8099
    assert not (tmp_path / "endpoint").exists(), "a value must NOT get a folder of its own"


def test_an_absent_nested_value_stays_absent(tmp_path):
    assert _round_trip(Everything(name="n"), tmp_path).nested is None


def test_a_document_becomes_its_own_file(tmp_path):
    value = Everything(name="n", doc=Doc(title="Setup", body="Run lsof -i."))
    back = _round_trip(value, tmp_path)
    assert (tmp_path / "doc.md").is_file(), "a document is a file named for its field"
    assert back.doc.body == "Run lsof -i."
    assert back.doc.title == "Setup", "frontmatter must survive beside the body"


def test_a_document_with_no_frontmatter_is_all_body(tmp_path):
    back = _round_trip(Everything(name="n", doc=Doc(body="just text")), tmp_path)
    assert back.doc.body == "just text"


def test_a_named_list_becomes_a_directory_per_name(tmp_path):
    value = Everything(name="n", steps=[Step(name="probe"), Step(name="bind")])
    back = _round_trip(value, tmp_path)
    assert (tmp_path / "steps" / "probe" / "step.json").is_file()
    assert {s.name for s in back.steps} == {"probe", "bind"}


def test_an_unnamed_list_uses_ordinals_and_keeps_its_order(tmp_path):
    """The old writer REFUSED this — `.name is required to place it in a
    directory` — so an ordinary list of values could not be saved at all."""
    value = Everything(name="n", unnamed=[Endpoint(port=1), Endpoint(port=2), Endpoint(port=3)])
    back = _round_trip(value, tmp_path)
    assert sorted(p.name for p in (tmp_path / "unnamed").iterdir()) == ["0001", "0002", "0003"]
    assert [e.port for e in back.unnamed] == [1, 2, 3], "ordinal order must be insertion order"


def test_an_empty_list_survives(tmp_path):
    assert _round_trip(Everything(name="n"), tmp_path).steps == []


def test_a_dict_of_shapes_becomes_a_directory_per_key(tmp_path):
    value = Everything(name="n", by_key={"primary": Endpoint(port=1), "backup": Endpoint(port=2)})
    back = _round_trip(value, tmp_path)
    assert (tmp_path / "by_key" / "primary").is_dir()
    assert {k: v.port for k, v in back.by_key.items()} == {"primary": 1, "backup": 2}


def test_a_dict_of_scalars_stays_inline(tmp_path):
    """A `dict[str, str]` is a value. A folder of one-line files would be a
    worse way to hold it, not a better one."""
    back = _round_trip(Everything(name="n", env={"A": "1"}), tmp_path)
    assert back.env == {"A": "1"}
    assert not (tmp_path / "env").exists()


def test_three_levels_of_nesting(tmp_path):
    value = Everything(name="n", steps=[Step(name="probe", setup=Doc(body="deep"))])
    back = _round_trip(value, tmp_path)
    assert (tmp_path / "steps" / "probe" / "setup.md").is_file()
    assert back.steps[0].setup.body == "deep"


def test_everything_at_once_is_identity(tmp_path):
    """The whole table in one value — the case that catches two placements
    interfering with each other."""
    value = Everything(
        name="pick-port", count=3, maybe="yes",
        endpoint=Endpoint(port=8099), nested=Endpoint(port=7000),
        doc=Doc(title="Setup", body="Run lsof -i."),
        steps=[Step(name="probe", setup=Doc(body="deep"))],
        unnamed=[Endpoint(port=1), Endpoint(port=2)],
        by_key={"primary": Endpoint(port=9000)},
        env={"A": "1", "B": "2"},
    )
    assert _round_trip(value, tmp_path) == value


def test_saving_twice_keeps_the_id_and_the_value(tmp_path):
    """§6 — a folder keeps its identity across saves, or every re-save forks
    the entity it stands for."""
    value = Everything(name="n")
    first = save(value, tmp_path)
    assert save(value, tmp_path) == first
    assert load(Everything, tmp_path) == value


def test_only_the_root_carries_an_identity(tmp_path):
    """A list element is part of its parent's value, not an entity. An identity
    capsule beside every row would make a copied folder claim to BE the row."""
    save(Everything(name="n", steps=[Step(name="probe")]), tmp_path)
    capsules = [p for p in tmp_path.rglob("identity.json")]
    assert len(capsules) == 1 and capsules[0].parent.parent.parent == tmp_path


# ── the phase-2 readiness pin ─────────────────────────────────────────────────

class Question(DataSpec):
    prompt: str = ""


class Answer(DataSpec):
    text: str = ""
    score: float = 0.0


def test_a_generic_parametrization_is_named_after_its_origin(tmp_path):
    """A parametrization inherits its origin's kind and does not register, so
    its ``__name__`` is ``ExampleSpec[Question, Answer, DataSpec]`` — brackets,
    commas and spaces. None of that belongs in a filename."""
    from flow_sdk.schema.data_spec.dataset_spec import ExampleSpec
    from flow_sdk.schema.data_spec.io import names

    parametrized = ExampleSpec[Question, Answer, DataSpec]
    assert names.main_document(parametrized) == "examplespec.json"


def test_an_example_saves_as_an_ordinary_spec(tmp_path):
    """**The readiness test for the unified-IO phase.**

    An execution's ``input``/``output`` must be ordinary fields of an ordinary
    spec — no bespoke layout, no dataset-specific code path. The layout this
    replaces could not write a ``DataSpec`` into a slot at all (it raised
    ``cannot write a Endpoint slot``) and its write→read was not identity. If
    this test passes, phase 2 is a migration; if it fails, nothing was prepared.
    """
    from flow_sdk.schema.data_spec.dataset_spec import ExampleSpec

    example_type = ExampleSpec[Question, Answer, DataSpec]
    example = example_type(
        input=Question(prompt="what is 2+2?"),
        output=Answer(text="4", score=1.0),
        ground_truth=Answer(text="4", score=1.0),
    )
    save(example, tmp_path)
    assert load(example_type, tmp_path) == example


def test_a_dataset_slot_may_be_any_shape_not_only_an_artifact(tmp_path):
    """The layout used to know exactly three leaf types and RAISE for anything
    else — ``cannot write a Endpoint slot`` — so a typed example was
    declarable and unwritable. Both ends now defer to the one walker, so a slot
    is an ordinary field and the round trip is identity three ways.
    """
    from flow_sdk.schema.data_spec.dataset_spec import ExampleSpec
    from flow_sdk.schema.data_spec.layout import FolderLayout

    example_type = ExampleSpec[Question, Answer, DataSpec]
    example = example_type(
        input=Question(prompt="what is 2+2?"),
        output=Answer(text="4", score=1.0),
        ground_truth=Answer(text="4", score=1.0),
    )
    FolderLayout().write(tmp_path, [example], dataset_id="ds")

    written = sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file())
    assert written == [
        "examples/0001/example.json",
        "examples/0001/ground_truth/answer.json",
        "examples/0001/input/question.json",
        "examples/0001/output/answer.json",
    ], "a slot is a folder of its shape; and it mints no identity of its own"

    back = FolderLayout().read(tmp_path, example_type, dataset_id="ds")[0]
    assert (back.input, back.output, back.ground_truth) == (
        example.input, example.output, example.ground_truth,
    )


def test_saving_into_an_existing_asset_folder_adopts_its_identity(tmp_path):
    """**A save must never re-key an entity that already has a name.**

    The identity capsule is ``{"version": 1, "data": {"id": …}}`` and is owned
    by ``flow_sdk.capsules``. A carrier that wrote a bare ``{"id": …}`` would
    read no id out of a REAL folder, mint a fresh one, and overwrite the
    capsule — silently turning someone's asset into a different entity. This
    pins the envelope and the adopt-don't-replace rule together.
    """
    import json

    from flow_sdk.schema.data_spec.io.identity import ensure_id

    existing = "1525f88b-d2c8-4009-a7a9-0e775a10358c"
    capsule = tmp_path / ".flow" / "capsules" / "identity.json"
    capsule.parent.mkdir(parents=True)
    capsule.write_text(json.dumps({"data": {"id": existing}, "version": 1}))

    save(Everything(name="n"), tmp_path)

    assert ensure_id(tmp_path) == existing, "the folder's own id must win"
    assert json.loads(capsule.read_text()) == {"data": {"id": existing}, "version": 1}


def test_a_minted_capsule_is_written_in_the_shared_envelope(tmp_path):
    """What this writer produces must be readable by every other reader of that
    file — the asset identity carrier, the indexer, a later save."""
    import json

    save(Everything(name="n"), tmp_path)
    written = json.loads((tmp_path / ".flow" / "capsules" / "identity.json").read_text())
    assert set(written) == {"data", "version"} and written["version"] == 1
    assert set(written["data"]) == {"id"}
