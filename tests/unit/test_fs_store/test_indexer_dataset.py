"""Indexer tests for the DATASET type.

Covers both physical layouts (``CSV`` and ``IO_FOLDER``) end-to-end through the
slot functions:
- ``repo_assets_fn`` emits one FSRef per ``agentic-assets/dataset/<slug>/`` folder.
- ``extract_dataset`` parses the manifest + rows into one FSRecord with counts.
- ``iter_examples`` normalizes both layouts into the shared ``Example`` shape.
- ``TypeInfo.mint_id`` adopts a valid manifest id else mints a capsule v4.

Pure-sync (no scan needed): the walker is called directly with a project node.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.dataset import DataLayoutEnum, ExampleKind
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from tests.unit.test_fs_store._dataset_tree import (
    keys as _keys,
    node as _node,
    paths as _paths,
    sidecar as _sidecar,
)
from flow_sdk.fs_store.indexer.functions.dataset import (
    dataset_asset_hash,
    extract_dataset,
    iter_examples,
)
from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def _mint(ref: FSRef) -> str:
    return SchemaRegistry.get("dataset").mint_entity_id(ref, derive=True, overwrite=True)


def _extract(ref: FSRef):
    return extract_dataset(ref, _mint(ref))

# do not increase timeout without approval — these are pure-sync parses (<1s).
pytestmark = pytest.mark.timeout(5)


# ── fixtures ──────────────────────────────────────────────────────────────────

def _doc(metadata: dict | None = None, data: dict | None = None) -> str:
    """A two-section dataset JSON string: {"metadata": {...}, "data": {...}}."""
    return json.dumps({"metadata": metadata or {}, "data": data or {}})


def _seed_csv_dataset(
    project: Path,
    slug: str,
    *,
    manifest: dict,
    csv_text: str,
) -> Path:
    ds = project / "agentic-assets" / "dataset" / slug
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

    ``manifest`` / ``manifest_data`` become the dataset.json metadata / data sections.
    Per-example ``spec`` keys (all optional):
      - ``input`` / ``expected`` — shorthand → ``input.txt`` / ``expected.txt``
      - ``meta`` / ``data`` — dicts → ``meta.json`` metadata / data sections
      - ``files`` — ``{relpath: str | bytes}`` written verbatim (bytes → binary)
      - ``dirs`` — ``{dirname: {fname: str | bytes}}`` for folder artifacts
    """
    ds = project / "agentic-assets" / "dataset" / slug
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


def _write_file(p: Path, content: str | bytes) -> None:
    """Write text or bytes to ``p``, creating parent dirs."""
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content) if isinstance(content, bytes) else p.write_text(content, encoding="utf-8")


# ── CSV layout ────────────────────────────────────────────────────────────────

def test_csv_happy_path(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path,
        "qa",
        manifest={"title": "QA set", "data_layout": "csv"},
        csv_text=(
            "kind,input,expected\n"
            "train,2+2,4\n"
            "train,3+3,6\n"
            "eval,9+1,10\n"
        ),
    )
    records = _extract(FSRef(ds))
    assert len(records) == 1
    rec = records[0]
    assert rec.type == RecordType.DATASET
    assert rec.name == "QA set"
    meta = rec.meta_dict()["metadata"]
    assert meta["num_examples"] == 3
    assert meta["kind_counts"] == {"train": 2, "eval": 1}


def test_csv_field_spec_maps_columns(tmp_path: Path) -> None:
    """Non-canonical headers (question/answer) mapped via field_spec; leftover
    columns land in Example.metadata."""
    ds = _seed_csv_dataset(
        tmp_path,
        "mapped",
        manifest={
            "data_layout": "csv",
            "field_spec": {"input": "question", "expected": "answer"},
        },
        csv_text=(
            "question,answer,difficulty\n"
            "capital of France?,Paris,easy\n"
        ),
    )
    rows = iter_examples(
        ds,
        DataLayoutEnum.CSV,
        {"input": "question", "expected": "answer"},
        ",",
        dataset_id="ds-1",
    )
    assert len(rows) == 1
    assert _node(rows[0], "input").value == "capital of France?"
    assert _node(rows[0], "ground_truth").value == "Paris"
    assert rows[0].metadata == {"difficulty": "easy"}
    assert rows[0].kind == ExampleKind.TRAIN  # no kind column → default


# ── IO_FOLDER layout ──────────────────────────────────────────────────────────

def test_io_folder_happy_path(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "io",
        examples={
            "0001": {"input": "hello", "expected": "world", "meta": {"kind": "eval"}},
            "0002": {"input": "foo", "expected": "bar"},
        },
    )
    records = _extract(FSRef(ds))
    assert len(records) == 1
    meta = records[0].meta_dict()["metadata"]
    assert meta["num_examples"] == 2
    assert meta["kind_counts"] == {"eval": 1, "train": 1}

    rows = iter_examples(ds, DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="ds-io")
    by_name = {r.metadata.get("kind", "train"): r for r in rows}
    assert _node(by_name["eval"], "input").value == "input.txt"
    assert _node(by_name["eval"], "ground_truth").value == "expected.txt"
    assert by_name["eval"].kind == ExampleKind.EVAL


def test_io_folder_missing_expected_is_none(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path,
        "unlabeled",
        examples={"0001": {"input": "prompt only"}},
    )
    rows = iter_examples(ds, DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="ds-u")
    assert len(rows) == 1
    assert _node(rows[0], "input").value == "input.txt"
    assert not _keys(rows[0], "ground_truth")


# ── walker ────────────────────────────────────────────────────────────────────

def test_repo_walker_emits_one_ref_per_dataset(tmp_path: Path) -> None:
    _seed_csv_dataset(tmp_path, "A", manifest={"data_layout": "csv"}, csv_text="input\nx\n")
    _seed_csv_dataset(tmp_path, "B", manifest={"data_layout": "csv"}, csv_text="input\ny\n")
    # A folder without dataset.json must be skipped.
    (tmp_path / "agentic-assets" / "dataset" / "no-manifest").mkdir(parents=True)

    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    refs = repo_assets_fn([node], IndexerOptions(verbose=False))

    assert len(refs) == 2
    assert all(r.record_type == RecordType.DATASET for r in refs)
    names = sorted(Path(r.path).name for r in refs)
    assert names == ["A", "B"]


def test_repo_walker_no_dataset_dir(tmp_path: Path) -> None:
    node = FSRef(tmp_path, record_type=RecordType.REAL_PROJECT_CWD)
    assert repo_assets_fn([node], IndexerOptions(verbose=False)) == []


# ── id minting ────────────────────────────────────────────────────────────────

def test_gen_id_adopts_valid_manifest_id(tmp_path: Path) -> None:
    valid = str(uuid.uuid4())  # v4 → adoptable
    ds = _seed_csv_dataset(
        tmp_path, "adopt", manifest={"id": valid, "data_layout": "csv"}, csv_text="input\nx\n"
    )
    assert _mint(FSRef(ds)) == valid


def test_gen_id_mints_v4_capsule_when_absent(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(tmp_path, "derive", manifest={"data_layout": "csv"}, csv_text="input\nx\n")
    first = _mint(FSRef(ds))
    second = _mint(FSRef(ds))
    assert first == second  # idempotent (adopted from the .flow/id capsule)
    assert uuid.UUID(first).version == 4  # capsule-v4: a fresh random id, not uuid5(path)


def test_gen_id_ignores_foreign_id_version(tmp_path: Path) -> None:
    """A non-v4/v5 id (e.g. a hand-authored v7) must be ignored, not adopted."""
    v7 = "018f5b2a-7c00-7000-8000-000000000000"  # version nibble = 7
    ds = _seed_csv_dataset(
        tmp_path, "v7", manifest={"id": v7, "data_layout": "csv"}, csv_text="input\nx\n"
    )
    minted = _mint(FSRef(ds))
    assert minted != v7
    assert uuid.UUID(minted).version == 4  # foreign id rejected → fresh v4 into the capsule


# ── example id determinism ────────────────────────────────────────────────────

def test_asset_hash_tracks_inner_file_edits(tmp_path: Path) -> None:
    """A folder's own mtime doesn't move on inner-content edits, so the hash must
    track data.csv (CSV) and the example files (IO_FOLDER) directly."""
    csv_ds = _seed_csv_dataset(
        tmp_path, "csv", manifest={"data_layout": "csv"}, csv_text="input\nx\n"
    )
    before = dataset_asset_hash(FSRef(csv_ds))
    import os
    os.utime(csv_ds / "data.csv", (before + 100, before + 100))
    assert dataset_asset_hash(FSRef(csv_ds)) > before

    io_ds = _seed_io_dataset(tmp_path, "io", examples={"0001": {"input": "a", "expected": "b"}})
    before_io = dataset_asset_hash(FSRef(io_ds))
    os.utime(io_ds / "examples" / "0001" / "input.txt", (before_io + 100, before_io + 100))
    assert dataset_asset_hash(FSRef(io_ds)) > before_io


def test_example_id_is_deterministic(tmp_path: Path) -> None:
    ds = _seed_csv_dataset(
        tmp_path, "det", manifest={"data_layout": "csv"}, csv_text="input\na\nb\n"
    )
    rows1 = iter_examples(ds, DataLayoutEnum.CSV, {}, ",", dataset_id="ds-X")
    rows2 = iter_examples(ds, DataLayoutEnum.CSV, {}, ",", dataset_id="ds-X")
    assert [r.id for r in rows1] == [r.id for r in rows2]
    assert rows1[0].id == str(uuid.uuid5(uuid.NAMESPACE_DNS, "ds-X:0"))


# ══ extended io_folder: slots, multi-output, consensus GT, sidecar metadata ══


def _one(ds: Path):
    rows = iter_examples(ds, DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="ds-x")
    assert len(rows) == 1
    return rows[0]


# ── Rule 1: input file vs folder ──

def test_input_file_with_extension(tmp_path: Path) -> None:
    ds = _seed_io_dataset(tmp_path, "im", examples={"0001": {"files": {"input.md": "# hi"}}})
    ex = _one(ds)
    assert _node(ex, "input").is_leaf
    assert _node(ex, "input").value == "input.md"


def test_input_folder_lists_files(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "if", examples={"0001": {"dirs": {"input": {"a.txt": "A", "b.txt": "B"}}}}
    )
    ex = _one(ds)
    assert not _node(ex, "input").is_leaf
    assert _paths(_node(ex, "input")) == ["input/a.txt", "input/b.txt"]


def test_input_binary_not_read(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "ib", examples={"0001": {"files": {"input.pdf": b"%PDF-1.4\x00\xff"}}}
    )
    ex = _one(ds)  # must not raise UnicodeDecodeError
    assert _node(ex, "input").is_leaf
    assert _node(ex, "input").value == "input.pdf"  # referenced, never read


def test_input_file_beats_folder(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "ifb",
        examples={"0001": {"files": {"input.txt": "scalar"}, "dirs": {"input": {"x.txt": "X"}}}},
    )
    ex = _one(ds)
    assert _node(ex, "input").is_leaf
    assert _node(ex, "input").value == "input.txt"
    assert len(_keys(ex, "input")) == 1  # folder ignored


def test_input_layout_hint(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "il",
        examples={"0001": {"input": "x", "files": {"example.json": _doc(metadata={"layout": "pages"})}}},
    )
    assert _one(ds).layout == "pages"


def test_missing_input_skips_example(tmp_path: Path) -> None:
    ds = _seed_io_dataset(tmp_path, "noin", examples={"0001": {"files": {"output.txt": "o"}}})
    assert iter_examples(ds, DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="ds-x") == []


# ── Rule 2: output file/folder + numbered multiples ──

def test_output_single_file(tmp_path: Path) -> None:
    ds = _seed_io_dataset(tmp_path, "o1", examples={"0001": {"input": "i", "files": {"output.txt": "out"}}})
    ex = _one(ds)
    assert _keys(ex, "output") == ["output"]
    assert _node(ex, "output").value == "output.txt"


def test_output_folder(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "of", examples={"0001": {"input": "i", "dirs": {"output": {"o.json": "{}"}}}}
    )
    ex = _one(ds)
    assert not _node(ex, "output").is_leaf
    assert _paths(_node(ex, "output")) == ["output/o.json"]


def test_output_numbered_ordered(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "on",
        examples={"0001": {"input": "i", "files": {"output-2.txt": "B", "output-1.txt": "A", "output-3.txt": "C"}}},
    )
    ex = _one(ds)
    idxs = _keys(ex, "output")
    assert idxs == ["output-1", "output-2", "output-3"]


def test_output_bare_and_numbered_coexist(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "obn",
        examples={"0001": {"input": "i", "files": {"output.txt": "bare", "output-1.txt": "one"}}},
    )
    ex = _one(ds)
    assert _keys(ex, "output") == ["output", "output-1"]  # bare first


def test_output_numbered_folder_binary(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "onf",
        examples={"0001": {"input": "i", "dirs": {"output-1": {"a.bin": b"\x00\x01"}}}},
    )
    ex = _one(ds)
    assert not _node(ex, "output").is_leaf
    assert _keys(ex, "output") == ["output-1"]
    assert _paths(_node(ex, "output")) == ["output-1/a.bin"]


def test_output_never_feeds_expected(tmp_path: Path) -> None:
    ds = _seed_io_dataset(tmp_path, "one", examples={"0001": {"input": "i", "files": {"output.txt": "o"}}})
    assert not _keys(_one(ds), "ground_truth")  # output is candidate, not gold


# ── Rule 3: ground_truth file/folder + consensus + gold ──

def test_gt_single_file(tmp_path: Path) -> None:
    ds = _seed_io_dataset(tmp_path, "g1", examples={"0001": {"input": "i", "files": {"ground_truth.txt": "gt"}}})
    ex = _one(ds)
    assert _node(ex, "ground_truth").value == "ground_truth.txt"


def test_gt_folder_structured(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "gf",
        examples={"0001": {"input": "i", "dirs": {"ground_truth": {"grade.json": '{"total":24}'}}}},
    )
    ex = _one(ds)
    assert not _node(ex, "ground_truth").is_leaf
    assert _paths(_node(ex, "ground_truth")) == ["ground_truth/grade.json"]


def test_gt_multiple_annotations(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "gm",
        examples={"0001": {"input": "i", "files": {
            "ground_truth-1.txt": "a", "ground_truth-2.txt": "b", "ground_truth-3.txt": "c",
        }}},
    )
    ex = _one(ds)
    assert _keys(ex, "ground_truth") == ["ground_truth-1", "ground_truth-2", "ground_truth-3"]


def test_gt_takes_precedence_over_output(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "gp",
        examples={"0001": {"input": "i", "files": {"output.txt": "o", "ground_truth.txt": "g"}}},
    )
    assert _node(_one(ds), "ground_truth").value == "ground_truth.txt"


def test_legacy_expected_maps_to_gt(tmp_path: Path) -> None:
    ds = _seed_io_dataset(tmp_path, "le", examples={"0001": {"input": "i", "expected": "w"}})
    ex = _one(ds)
    # legacy expected.txt is re-keyed under ground_truth; the path is unchanged
    assert _keys(ex, "ground_truth") == ["ground_truth"]
    assert _node(ex, "ground_truth").value == "expected.txt"


def test_native_gt_wins_over_legacy_expected(tmp_path: Path) -> None:
    """A native ``ground_truth`` beats the legacy alias — and the alias is DROPPED.

    Asserts the whole key set, not just the winner: `expected.txt` leaving the
    tree entirely is the actual behaviour and nothing else pinned it.
    """
    ds = _seed_io_dataset(
        tmp_path, "ngt",
        examples={"0001": {"input": "i", "expected": "legacy", "files": {"ground_truth.txt": "g"}}},
    )
    ex = _one(ds)
    assert sorted(ex.datum.fields) == ["ground_truth", "input"]
    assert _node(ex, "ground_truth").value == "ground_truth.txt"


def test_numbered_sidecar_attaches_per_index(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "nsc",
        examples={"0001": {"input": "i",
                           "dirs": {"ground_truth-2": {"grade.json": "{}"}},
                           "files": {"ground_truth-2.json": _doc(metadata={"rater": "B"})}}},
    )
    ex = _one(ds)
    assert _keys(ex, "ground_truth") == ["ground_truth-2"]
    assert _sidecar(ex, "ground_truth-2.json").get("metadata", {}) == {"rater": "B"}


def test_orphan_bare_sidecar_to_slot_metadata(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "osc",
        examples={"0001": {"input": "i", "files": {"output.json": _doc(metadata={"note": "x"})}}},
    )
    ex = _one(ds)
    assert not _keys(ex, "output")  # a lone sidecar is not data
    assert _sidecar(ex, "output.json").get("metadata", {}) == {"note": "x"}


def test_sidecar_only_gold_is_not_annotated(tmp_path: Path) -> None:
    """A lone ``ground_truth.json`` is metadata ABOUT gold, not gold.

    It used to be counted as annotated (the slot existed because a sidecar did),
    which disagreed with the example's own absent gold. "Annotated" now means a
    real gold DATA key.
    """
    ds = _seed_io_dataset(
        tmp_path, "sog",
        examples={"0001": {"input": "i", "files": {"ground_truth.json": _doc(metadata={"m": 1})}}},
    )
    assert not _keys(_one(ds), "ground_truth")
    meta = _extract(FSRef(ds))[0].meta_dict()["metadata"]
    assert meta["num_annotated"] == 0


def test_sidecar_only_input_skips_example(tmp_path: Path) -> None:
    """An example whose only ``input*`` entry is a sidecar has no input at all."""
    ds = _seed_io_dataset(
        tmp_path, "soi",
        examples={"0001": {"files": {"input.json": _doc(metadata={"pages": 1})}}},
    )
    assert iter_examples(ds, DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="ds-x") == []


def test_occurrence_order_rides_on_key_order(tmp_path: Path) -> None:
    """Ordering (bare first, then numbered ascending) is carried by KEY ORDER now.

    Dict equality ignores key order, so the whole-tree comparison in the loader
    suite cannot catch an ordering regression — this asserts the sequence.
    """
    ds = _seed_io_dataset(
        tmp_path, "ord",
        examples={"0001": {"input": "i", "files": {
            "output-2.txt": "b", "output.txt": "bare", "output-10.txt": "j", "output-1.txt": "a",
        }}},
    )
    assert _keys(_one(ds), "output") == ["output", "output-1", "output-2", "output-10"]


def test_example_json_canonical(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "ejc",
        examples={"0001": {"input": "i",
                           "files": {"example.json": _doc(metadata={"kind": "eval"}, data={"tag": "x"})}}},
    )
    ex = _one(ds)
    assert ex.kind == ExampleKind.EVAL
    assert ex.metadata == {"kind": "eval"}   # known section
    assert ex.data == {"tag": "x"}           # free section


def test_example_json_overrides_meta_alias(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "ejo",
        examples={"0001": {"input": "i", "meta": {"kind": "train", "a": 1},
                           "files": {"example.json": _doc(metadata={"kind": "test", "b": 2})}}},
    )
    ex = _one(ds)
    assert ex.kind == ExampleKind.TEST            # canonical wins
    assert ex.metadata == {"kind": "test", "a": 1, "b": 2}


def test_meta_json_alias_still_works(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "mja", examples={"0001": {"input": "i", "meta": {"kind": "test", "k": "v"}}}
    )
    ex = _one(ds)
    assert ex.kind == ExampleKind.TEST
    assert ex.metadata == {"kind": "test", "k": "v"}


def test_reserved_keys_lifted_but_preserved(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "rk",
        examples={"0001": {"input": "i", "files": {
            "example.json": _doc(metadata={"kind": "test", "layout": "pages"}, data={"foo": 1}),
        }}},
    )
    ex = _one(ds)
    assert ex.kind == ExampleKind.TEST
    assert ex.layout == "pages"
    assert ex.metadata == {"kind": "test", "layout": "pages"}  # lifted yet still present
    assert ex.data == {"foo": 1}                               # free keys live in data


def test_example_id_not_adopted_from_json(tmp_path: Path) -> None:
    foreign = str(uuid.uuid4())
    ds = _seed_io_dataset(
        tmp_path, "eid",
        examples={"0001": {"input": "i", "files": {"example.json": _doc(metadata={"id": foreign})}}},
    )
    ex = _one(ds)
    assert ex.id == str(uuid.uuid5(uuid.NAMESPACE_DNS, "ds-x:0001"))
    assert ex.id != foreign


def test_dataset_json_extra_keys_preserved_in_record(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "dje",
        examples={"0001": {"input": "i"}},
        manifest={"data_layout": "io_folder"},
        manifest_data={"owner": "eran"},
    )
    rec = _extract(FSRef(ds))[0]
    assert rec.meta_dict()["metadata"]["data"]["owner"] == "eran"  # free dataset data section


# ── determinism / counts / hash ──

def test_extract_surfaces_new_counts(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "cnt",
        examples={
            "0001": {"files": {"input.pdf": b"%PDF"}},                        # binary input
            "0002": {"input": "i", "files": {"output-1.txt": "a", "output-2.txt": "b"}},  # multi-output
            "0003": {"input": "i", "files": {"ground_truth.txt": "g"}},       # annotated
        },
    )
    meta = _extract(FSRef(ds))[0].meta_dict()["metadata"]
    assert meta["num_examples"] == 3
    assert meta["num_binary_inputs"] == 1
    assert meta["num_multi_output"] == 1
    assert meta["num_annotated"] == 1


def test_asset_hash_tracks_nested_new_forms(tmp_path: Path) -> None:
    import os
    ds = _seed_io_dataset(
        tmp_path, "nh",
        examples={"0001": {"input": "i", "dirs": {"output-2": {"a.txt": "x"}}}},
    )
    before = dataset_asset_hash(FSRef(ds))
    nested = ds / "examples" / "0001" / "output-2" / "a.txt"
    os.utime(nested, (before + 100, before + 100))
    assert dataset_asset_hash(FSRef(ds)) > before


# ── integration ──

def test_mixed_dataset_endtoend(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "mix",
        examples={
            "0001": {"input": "legacy-in", "expected": "legacy-gold", "meta": {"kind": "eval"}},
            "0002": {
                "dirs": {
                    "input": {"scan.pdf": b"%PDF"},
                    "ground_truth": {"grade.json": '{"total":1}'},
                    "ground_truth-2": {"grade.json": '{"total":2}'},
                },
                "files": {
                    "output-1.txt": "cand-1", "output-2.txt": "cand-2",
                    "ground_truth.json": _doc(metadata={"rater": "A"}),
                    "example.json": _doc(metadata={"kind": "eval", "layout": "pages"}),
                },
            },
        },
    )
    rows = iter_examples(ds, DataLayoutEnum.IO_FOLDER, {}, ",", dataset_id="ds-x")
    legacy, rich = rows[0], rows[1]

    # legacy example: scalars intact
    assert _node(legacy, "input").value == "input.txt"
    assert _node(legacy, "ground_truth").value == "expected.txt"
    assert legacy.kind == ExampleKind.EVAL

    # rich example: structured slots
    assert not _node(rich, "input").is_leaf
    assert _keys(rich, "output") == ["output-1", "output-2"]
    assert _sidecar(rich, "ground_truth.json").get("metadata", {}) == {"rater": "A"}  # bare sidecar → bare folder artifact
    assert _keys(rich, "ground_truth") == ["ground_truth", "ground_truth-2"]
    assert rich.layout == "pages"

    meta = _extract(FSRef(ds))[0].meta_dict()["metadata"]
    assert meta["num_examples"] == 2
    assert meta["num_multi_output"] == 1
    assert meta["num_annotated"] == 2  # both examples have a ground_truth slot


# ── two-section JSON: metadata (flowpad-managed) + data (free) ──

def test_doc_two_section_split(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "split",
        examples={"0001": {"input": "i",
                           "files": {"example.json": _doc(metadata={"kind": "eval"}, data={"foo": 1})}}},
    )
    ex = _one(ds)
    assert ex.kind == ExampleKind.EVAL
    assert ex.metadata == {"kind": "eval"}
    assert ex.data == {"foo": 1}


def test_flat_example_json_ignored(tmp_path: Path) -> None:
    """A flat doc (no metadata/data sections) yields empty sections — mandatory."""
    ds = _seed_io_dataset(
        tmp_path, "flat",
        examples={"0001": {"input": "i", "files": {"example.json": json.dumps({"kind": "eval"})}}},
    )
    ex = _one(ds)
    assert ex.kind == ExampleKind.TRAIN  # flat 'kind' not read
    assert ex.metadata == {}
    assert ex.data == {}


def test_bare_sidecar_two_section(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "bsc",
        examples={"0001": {"input": "i",
                           "files": {"output.json": _doc(metadata={"k": 1}, data={"free": True})}}},
    )
    ex = _one(ds)
    assert not _keys(ex, "output")  # a lone sidecar is not data
    assert _sidecar(ex, "output.json").get("metadata", {}) == {"k": 1}
    assert _sidecar(ex, "output.json").get("data", {}) == {"free": True}


def test_example_meta_two_section_merge(tmp_path: Path) -> None:
    """meta.json (alias) + example.json (canonical) merge per section."""
    ds = _seed_io_dataset(
        tmp_path, "merge",
        examples={"0001": {"input": "i",
                           "meta": {"kind": "train", "a": 1},          # → meta.json metadata
                           "data": {"x": 1},                            # → meta.json data
                           "files": {"example.json": _doc(metadata={"kind": "test", "b": 2}, data={"y": 2})}}},
    )
    ex = _one(ds)
    assert ex.kind == ExampleKind.TEST                       # canonical wins
    assert ex.metadata == {"kind": "test", "a": 1, "b": 2}   # metadata sections merged
    assert ex.data == {"x": 1, "y": 2}                       # data sections merged


def test_dataset_json_two_section(tmp_path: Path) -> None:
    ds = _seed_io_dataset(
        tmp_path, "djts",
        examples={"0001": {"input": "i"}},
        manifest={"data_layout": "io_folder", "title": "T"},
        manifest_data={"owner": "eran", "team": "ml"},
    )
    meta = _extract(FSRef(ds))[0].meta_dict()["metadata"]
    assert meta["data_layout"] == "io_folder"          # known field from metadata section
    assert meta["data"] == {"owner": "eran", "team": "ml"}  # free dataset data section


def test_dataset_contract_is_parsed_and_normalized(tmp_path: Path) -> None:
    """The contract slot is a `Datum`, not an opaque blob.

    It is stored normalized because a consumer joins it against an example's
    `datum` by position — a malformed contract has no reading at that point, so
    it must fail here, where the file is still in hand.
    """
    ds = _seed_io_dataset(
        tmp_path, "contract",
        examples={"0001": {"input": "i"}},
        manifest={"data_layout": "io_folder",
                  "contract": {"fields": {"category": {"kind": "  String  "}}}},
    )
    meta = _extract(FSRef(ds))[0].meta_dict()["metadata"]
    assert meta["contract"] == {"fields": {"category": {"kind": "string"}}}


def test_dataset_without_a_contract_declares_none(tmp_path: Path) -> None:
    """Declaring no shape is legal — and the key is simply ABSENT, so indexing an
    existing dataset does not rewrite its metadata to add an explicit null."""
    ds = _seed_io_dataset(
        tmp_path, "no-contract",
        examples={"0001": {"input": "i"}},
        manifest={"data_layout": "io_folder"},
    )
    assert "contract" not in _extract(FSRef(ds))[0].meta_dict()["metadata"]


def test_a_malformed_contract_degrades_the_slot_not_the_dataset(tmp_path: Path) -> None:
    """A bad contract must never cost the examples.

    Raising out of the extractor would drop every Example record it also emits;
    the walk marks only the dataset's own id as seen before parsing, so an
    `orphan_action=DELETE` sweep would then reap example rows that parsed fine.
    """
    ds = _seed_io_dataset(
        tmp_path, "bad-contract",
        examples={"0001": {"input": "i"}},
        manifest={"data_layout": "io_folder",
                  "contract": {"fields": {"a": {}}, "value": 1}},
    )
    records = _extract(FSRef(ds))
    assert "contract" not in records[0].meta_dict()["metadata"]
    assert records[0].meta_dict()["metadata"]["num_examples"] == 1  # the row survived
