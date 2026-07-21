"""Tests for ``Dataset.from_fs_ref`` — the generic, DB-free on-disk loader.

``Entity.from_fs_ref(ref)`` dispatches to the type's registered cold-path parser
(``TypeInfo.from_disk_fn`` == ``extract_dataset`` for datasets) and builds the
entity generically from the returned ``FSRecord`` — no DB, no async. These tests
assert it is **fully indexer-compatible**: the loaded entity's id, typed fields,
denormalized counts, and ``examples()`` list match the indexer cold path
(``extract_dataset`` + ``iter_examples``) across the whole shape matrix.

Helpers (``_doc``/``_seed_*``) mirror ``test_indexer_dataset.py``.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.dataset import (
    ArtifactKind,
    DataLayoutEnum,
    Dataset,
    ExampleKind,
)
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.dataset import (
    extract_dataset,
    iter_examples,
)
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# do not increase timeout without approval — these are pure-sync parses (<1s).
pytestmark = pytest.mark.timeout(5)


def _extract(ref: FSRef):
    return extract_dataset(ref, SchemaRegistry.get("dataset").mint_id(ref))

# A real v4 uuid for manifest-id adoption tests.
VALID_V4 = "a3f1c2d4-5b6e-4f7a-8c9d-0e1f2a3b4c5d"


# ── seed helpers (copied from test_indexer_dataset.py, self-contained) ─────────

def _doc(metadata: dict | None = None, data: dict | None = None) -> str:
    """A two-section dataset JSON string: {"metadata": {...}, "data": {...}}."""
    return json.dumps({"metadata": metadata or {}, "data": data or {}})


def _write_file(p: Path, content: str | bytes) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content) if isinstance(content, bytes) else p.write_text(content, encoding="utf-8")


def _seed_csv_dataset(project: Path, slug: str, *, manifest: dict, csv_text: str) -> Path:
    ds = project / "assets" / "datasets" / slug
    ds.mkdir(parents=True)
    (ds / "dataset.json").write_text(_doc(metadata=manifest), encoding="utf-8")
    (ds / "data.csv").write_text(csv_text, encoding="utf-8")
    return ds


def _seed_io_dataset(
    project: Path,
    slug: str,
    *,
    examples: dict[str, dict],
    manifest: dict | None = None,
    manifest_data: dict | None = None,
) -> Path:
    """Seed an io_folder dataset.

    Per-example ``spec`` keys (all optional):
      - ``input`` / ``expected`` — shorthand → ``input.txt`` / ``expected.txt``
      - ``meta`` / ``data`` — dicts → ``meta.json`` metadata / data sections
      - ``files`` — ``{relpath: str | bytes}`` written verbatim (bytes → binary)
      - ``dirs``  — ``{dirname: {fname: str | bytes}}`` for folder artifacts
    """
    ds = project / "assets" / "datasets" / slug
    (ds / "examples").mkdir(parents=True)
    (ds / "dataset.json").write_text(
        _doc(metadata=manifest or {"data_layout": "io_folder"}, data=manifest_data),
        encoding="utf-8",
    )
    for name, spec in examples.items():
        ex = ds / "examples" / name
        ex.mkdir()
        if "input" in spec:
            (ex / "input.txt").write_text(spec["input"], encoding="utf-8")
        if "expected" in spec:
            (ex / "expected.txt").write_text(spec["expected"], encoding="utf-8")
        if "meta" in spec or "data" in spec:
            (ex / "meta.json").write_text(
                _doc(metadata=spec.get("meta"), data=spec.get("data")), encoding="utf-8"
            )
        for rel, content in spec.get("files", {}).items():
            _write_file(ex / rel, content)
        for dname, members in spec.get("dirs", {}).items():
            for fname, content in members.items():
                _write_file(ex / dname / fname, content)
    return ds


# ── the core indexer-compatibility assertion ──────────────────────────────────

def _assert_indexer_compatible(ds_path: Path) -> Dataset:
    """Load via from_fs_ref and assert it equals the indexer cold path."""
    ref = FSRef(ds_path)
    # gen_id stamps the `.flow/id` capsule first — the production index order
    # (TypeInfo resolves identity before the extractor). The loader + cold-path extractor
    # then adopt that same capsule id (a fresh v4 when the dataset carries no id).
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    gen = SchemaRegistry.get("dataset").mint_id(ref)
    loaded = Dataset.from_fs_ref(ref)
    assert loaded is not None, "from_fs_ref returned None for a real dataset"
    assert isinstance(loaded, Dataset)

    rec = _extract(ref)[0]
    meta = rec.meta_dict()["metadata"]

    # id: loader == gen_id == cold-path record id
    assert loaded.id == gen == rec.id

    # typed fields lifted from the nested `metadata` section
    assert loaded.data_layout == meta["data_layout"]
    assert loaded.field_spec == meta["field_spec"]
    assert loaded.delimiter == meta["delimiter"]
    assert loaded.num_examples == meta["num_examples"]
    assert loaded.kind_counts == meta["kind_counts"]

    # examples(): full list equality vs the indexer parser (pydantic __eq__)
    ref_rows = iter_examples(
        str(ds_path),
        DataLayoutEnum(loaded.data_layout),
        loaded.field_spec or {},
        loaded.delimiter or ",",
        dataset_id=loaded.id,
    )
    assert loaded.examples() == ref_rows
    return loaded


# ── Group 1: loader contract / generic dispatch ───────────────────────────────

def test_returns_typed_dataset_instance(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path, "qa", manifest={"data_layout": "csv"}, csv_text="input,expected\nx,y\n"
    )
    loaded = Dataset.from_fs_ref(FSRef(ds))
    assert type(loaded) is Dataset  # resolved via the registry, not base Entity


def test_non_dataset_folder_returns_none(tmp_path: Path) -> None:
    plain = tmp_path / "not_a_dataset"
    plain.mkdir()
    (plain / "readme.txt").write_text("hi", encoding="utf-8")
    assert Dataset.from_fs_ref(FSRef(plain)) is None


def test_asset_ref_stamped_as_path_string(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path, "qa", manifest={"data_layout": "csv"}, csv_text="input,expected\nx,y\n"
    )
    loaded = Dataset.from_fs_ref(FSRef(ds))
    # the path STRING (not an FSRef repr) — examples() does str(asset_ref)
    assert loaded.asset_ref == str(Path(ds).resolve())
    assert loaded.examples()  # non-empty proves the path resolves


def test_db_free_is_sync(tmp_path: Path) -> None:
    # from_fs_ref returns a Dataset directly — not a coroutine to await — unlike
    # the async, DB-persisting from_record. This is the pure on-disk load path.
    import inspect

    ds = _seed_csv_dataset(
        tmp_path, "qa", manifest={"data_layout": "csv"}, csv_text="input,expected\nx,y\n"
    )
    loaded = Dataset.from_fs_ref(FSRef(ds))
    assert not inspect.isawaitable(loaded)
    assert isinstance(loaded, Dataset)
    assert loaded.num_examples == 1


# ── Group 2: CSV matrix ────────────────────────────────────────────────────────

def test_csv_happy_path(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path,
        "qa",
        manifest={"title": "QA", "data_layout": "csv"},
        csv_text="kind,input,expected\ntrain,2+2,4\neval,9+1,10\n",
    )
    loaded = _assert_indexer_compatible(ds)
    assert loaded.title == "QA"
    assert loaded.num_examples == 2
    assert loaded.kind_counts == {"train": 1, "eval": 1}
    rows = loaded.examples()
    assert rows[0].input == "2+2" and rows[0].expected == "4"
    assert rows[1].kind == ExampleKind.EVAL


def test_csv_field_spec_remap_and_leftover_metadata(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path,
        "qa",
        manifest={"data_layout": "csv", "field_spec": {"input": "question", "expected": "answer"}},
        csv_text="question,answer,difficulty\ncapital of France?,Paris,easy\n",
    )
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert ex.input == "capital of France?" and ex.expected == "Paris"
    assert ex.metadata == {"difficulty": "easy"}  # unmapped column → metadata
    assert ex.kind == ExampleKind.TRAIN  # no kind column → default


def test_csv_custom_delimiter(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path,
        "qa",
        manifest={"data_layout": "csv", "delimiter": "\t"},
        csv_text="input\texpected\na\tb\n",
    )
    loaded = _assert_indexer_compatible(ds)
    assert loaded.delimiter == "\t"  # lifted from metadata (defaulted before the fix)
    assert loaded.examples()[0].input == "a"


# ── Group 3: IO_FOLDER slots & artifact forms ─────────────────────────────────

def test_io_input_single_file(tmp_path: Path) -> None:
    ds = _seed_io_dataset(tmp_path, "io", examples={"0001": {"input": "hello", "expected": "world"}})
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert ex.input == "hello" and ex.expected == "world"
    assert ex.input_slot.primary.kind == ArtifactKind.FILE
    assert ex.input_slot.primary.path == "input.txt"


def test_io_input_folder(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "io", examples={"0001": {"dirs": {"input": {"a.txt": "x", "b.txt": "y"}}}}
    )
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert ex.input == ""  # folder ⇒ no scalar
    assert ex.input_slot.primary.kind == ArtifactKind.FOLDER
    assert ex.input_slot.primary.files == ["input/a.txt", "input/b.txt"]


def test_io_input_binary_pdf(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "io", examples={"0001": {"files": {"input.pdf": b"%PDF-1.4 binary"}}}
    )
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert ex.input == ""  # binary ⇒ no scalar text
    assert ex.input_slot.primary.kind == ArtifactKind.FILE
    assert ex.input_slot.primary.text is None
    rec_meta = _extract(FSRef(ds))[0].meta_dict()["metadata"]
    assert rec_meta["num_binary_inputs"] == 1


def test_io_input_file_beats_folder(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={"0001": {"input": "scalar", "dirs": {"input": {"ignored.txt": "z"}}}},
    )
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert ex.input_slot.primary.kind == ArtifactKind.FILE
    assert ex.input == "scalar"


def test_io_output_numbered_multi(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={
            "0001": {
                "input": "q",
                "files": {"output-1.txt": "a", "output-2.txt": "b", "output-3.txt": "c"},
            }
        },
    )
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert [a.index for a in ex.output_slot.artifacts] == [1, 2, 3]
    assert len({a.id for a in ex.output_slot.artifacts}) == 3  # distinct ids
    assert ex.expected is None  # output never feeds the gold
    rec_meta = _extract(FSRef(ds))[0].meta_dict()["metadata"]
    assert rec_meta["num_multi_output"] == 1


def test_io_ground_truth_numbered_folders_consensus(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={
            "0001": {
                "input": "q",
                "dirs": {
                    "ground_truth-1": {"grade.json": "{}"},
                    "ground_truth-2": {"grade.json": "{}"},
                },
            }
        },
    )
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert [a.index for a in ex.ground_truth_slot.artifacts] == [1, 2]
    assert all(a.kind == ArtifactKind.FOLDER for a in ex.ground_truth_slot.artifacts)
    assert ex.expected is None  # structured folder gold ⇒ no scalar


def test_io_legacy_expected_folds_to_ground_truth(tmp_path: Path) -> None:
    ds = _seed_io_dataset(tmp_path, "io", examples={"0001": {"input": "q", "expected": "gold"}})
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert ex.expected == "gold"
    assert ex.ground_truth_slot is not None
    assert ex.ground_truth_slot.name == "ground_truth"


def test_io_native_gt_beats_legacy_expected(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={"0001": {"input": "q", "expected": "legacy", "files": {"ground_truth.txt": "native"}}},
    )
    loaded = _assert_indexer_compatible(ds)
    assert loaded.examples()[0].expected == "native"


# ── Group 4: sidecars & example metadata ──────────────────────────────────────

def test_sidecar_attaches_to_artifact(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={
            "0001": {
                "files": {
                    "input.pdf": b"%PDF binary",
                    "input.json": _doc(metadata={"pages": 3}, data={"src": "scan"}),
                }
            }
        },
    )
    loaded = _assert_indexer_compatible(ds)
    art = loaded.examples()[0].input_slot.primary
    assert art.kind == ArtifactKind.FILE and art.path == "input.pdf"
    assert art.metadata == {"pages": 3}
    assert art.data == {"src": "scan"}


def test_numbered_sidecar_per_index(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={
            "0001": {
                "input": "q",
                "files": {
                    "output-1.txt": "a",
                    "output-2.txt": "b",
                    "output-2.json": _doc(metadata={"rater": "B"}),
                },
            }
        },
    )
    loaded = _assert_indexer_compatible(ds)
    arts = {a.index: a for a in loaded.examples()[0].output_slot.artifacts}
    assert arts[1].metadata == {}
    assert arts[2].metadata == {"rater": "B"}


def test_bare_sidecar_to_slot_metadata(tmp_path: Path) -> None:
    # output.json with NO matching output data artifact → slot-level metadata.
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={"0001": {"input": "q", "files": {"output.json": _doc(metadata={"note": "n"})}}},
    )
    loaded = _assert_indexer_compatible(ds)
    slot = loaded.examples()[0].output_slot
    assert slot.artifacts == []
    assert slot.metadata == {"note": "n"}


def test_example_json_two_section_and_meta_override(tmp_path: Path) -> None:
    # meta.json (alias) + example.json (canonical) merge per section.
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={
            "0001": {
                "input": "q",
                "meta": {"kind": "test", "from_alias": 1},
                "files": {
                    "example.json": _doc(
                        metadata={"kind": "eval", "layout": "pages"}, data={"note": "x"}
                    )
                },
            }
        },
    )
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert ex.kind == ExampleKind.EVAL  # example.json wins
    assert ex.layout == "pages"
    assert ex.metadata.get("from_alias") == 1  # alias key survives the merge
    assert ex.data == {"note": "x"}


def test_flat_json_ignored(tmp_path: Path) -> None:
    # A FLAT example.json (no metadata/data sections) is malformed → ignored.
    ds = tmp_path / "assets" / "datasets" / "io"
    (ds / "examples" / "0001").mkdir(parents=True)
    (ds / "dataset.json").write_text(_doc(metadata={"data_layout": "io_folder"}), encoding="utf-8")
    (ds / "examples" / "0001" / "input.txt").write_text("q", encoding="utf-8")
    (ds / "examples" / "0001" / "example.json").write_text(
        json.dumps({"kind": "eval"}), encoding="utf-8"  # flat — no metadata/data
    )
    loaded = _assert_indexer_compatible(ds)
    ex = loaded.examples()[0]
    assert ex.kind == ExampleKind.TRAIN  # flat 'kind' not read → default
    assert ex.metadata == {}


# ── Group 5: comprehensive all-fields + determinism + filter ──────────────────

def test_comprehensive_all_fields(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "full",
        manifest={
            "id": VALID_V4,
            "title": "Full",
            "description": "every field",
            "data_layout": "io_folder",
            "delimiter": ",",
        },
        manifest_data={"owner": "eran@langware.ai"},
        examples={
            "0001": {
                "input": "the input",
                "files": {
                    "input.json": _doc(metadata={"pages": 1}, data={"pen": "blue"}),
                    "output-1.txt": "cand1",
                    "output-2.txt": "cand2",
                    "ground_truth.txt": "gold",
                    "example.json": _doc(
                        metadata={"kind": "eval", "layout": "pages"}, data={"note": "x"}
                    ),
                },
            }
        },
    )
    loaded = _assert_indexer_compatible(ds)

    # every Dataset field
    assert loaded.id == VALID_V4  # manifest id adopted
    assert loaded.title == "Full"
    assert loaded.description == "every field"
    assert loaded.data_layout == "io_folder"
    assert loaded.field_spec == {}
    assert loaded.delimiter == ","
    assert loaded.num_examples == 1
    assert loaded.kind_counts == {"eval": 1}
    assert loaded.data == {"owner": "eran@langware.ai"}
    assert loaded.created_at is None
    assert loaded.asset_ref == str(Path(ds).resolve())

    # every Example field
    ex = loaded.examples()[0]
    assert ex.id == str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{loaded.id}:0001"))
    assert ex.kind == ExampleKind.EVAL
    assert ex.input == "the input"
    assert ex.expected == "gold"
    assert ex.metadata == {"kind": "eval", "layout": "pages"}
    assert ex.data == {"note": "x"}
    assert ex.layout == "pages"
    assert ex.input_slot.primary.metadata == {"pages": 1}
    assert ex.input_slot.primary.data == {"pen": "blue"}
    assert [a.index for a in ex.output_slot.artifacts] == [1, 2]
    assert ex.ground_truth_slot.primary.text == "gold"

    # all five denormalized counts vs the cold-path record
    meta = _extract(FSRef(ds))[0].meta_dict()["metadata"]
    assert meta["num_examples"] == 1
    assert meta["kind_counts"] == {"eval": 1}
    assert meta["num_annotated"] == 1
    assert meta["num_multi_output"] == 1
    assert meta["num_binary_inputs"] == 0


def test_determinism_stable_ids(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={"0001": {"input": "q", "files": {"output-1.txt": "a"}}},
    )
    a = Dataset.from_fs_ref(FSRef(ds))
    b = Dataset.from_fs_ref(FSRef(ds))
    assert a.id == b.id
    ax, bx = a.examples()[0], b.examples()[0]
    assert ax.id == bx.id
    assert [art.id for art in ax.output_slot.artifacts] == [art.id for art in bx.output_slot.artifacts]


def test_examples_kind_filter(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path,
        "qa",
        manifest={"data_layout": "csv"},
        csv_text="kind,input,expected\ntrain,a,1\neval,b,2\neval,c,3\n",
    )
    loaded = Dataset.from_fs_ref(FSRef(ds))
    evals = loaded.examples(ExampleKind.EVAL)
    assert len(evals) == 2
    assert all(e.kind == ExampleKind.EVAL for e in evals)
    # matches the indexer parser filtered the same way
    ref_rows = [
        e
        for e in iter_examples(str(ds), DataLayoutEnum.CSV, {}, ",", dataset_id=loaded.id)
        if e.kind == ExampleKind.EVAL
    ]
    assert evals == ref_rows
