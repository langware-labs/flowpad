from __future__ import annotations

import json
import math
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from flow_sdk.capsules import (
    AssetCapsule,
    CapsuleData,
    CapsuleSpec,
    DuplicateCapsuleError,
    InvalidCapsuleNameError,
    MalformedCapsuleError,
    UnsupportedCapsuleFormatError,
    restore_capsule_blocks,
    snapshot_capsule_blocks,
    strip_capsule_blocks,
)


def _asset(tmp_path: Path, kind: str) -> Path:
    path = tmp_path / ("asset" if kind == "folder" else "asset.md")
    path.mkdir() if kind == "folder" else path.write_text("---\nname: A\n---\n\nbody", encoding="utf-8")
    return path


def test_capsule_data_is_json_exact_and_defensively_copied() -> None:
    source = {"nested": [{"name": "שלום"}], "enabled": True}
    capsule = CapsuleData(1, source)
    source["nested"][0]["name"] = "changed"
    exposed = capsule.data
    exposed["nested"][0]["name"] = "also changed"
    assert capsule.to_dict() == {"version": 1, "data": {"nested": [{"name": "שלום"}], "enabled": True}}


@pytest.mark.parametrize("bad", [{"x": math.nan}, {"x": object()}, {1: "x"}, {"x": (1, 2)}])
def test_capsule_data_rejects_non_json_values(bad) -> None:
    with pytest.raises((TypeError, ValueError)):
        CapsuleData(1, bad)


@pytest.mark.parametrize("version", [True, False, 0, -1, 1.5, "1"])
def test_capsule_data_and_spec_reject_invalid_versions(version) -> None:
    with pytest.raises((TypeError, ValueError)):
        CapsuleData(version, {})
    with pytest.raises((TypeError, ValueError)):
        CapsuleSpec("identity", version)


@pytest.mark.parametrize("raw", [{}, {"version": 1}, {"version": 1, "data": {}, "extra": 1}])
def test_capsule_data_requires_exact_envelope(raw) -> None:
    with pytest.raises(MalformedCapsuleError):
        CapsuleData.from_dict(raw)


@pytest.mark.parametrize("name", ["Identity", "../id", "two words", "con", ""])
def test_capsule_names_are_portable(name: str) -> None:
    with pytest.raises(InvalidCapsuleNameError):
        from flow_sdk.capsules import validate_capsule_name
        validate_capsule_name(name)


@pytest.mark.parametrize("kind", ["folder", "file"])
def test_shared_asset_capsule_contract(tmp_path: Path, kind: str) -> None:
    capsule = AssetCapsule.from_path(_asset(tmp_path, kind))
    one, two = CapsuleData(1, {"id": "one"}), CapsuleData(1, {"id": "two"})
    assert capsule.read("identity") is None
    assert capsule.write_if_absent("identity", one) == one
    assert capsule.write_if_absent("identity", two) == one
    assert capsule.write("other", two) == two
    assert capsule.names() == ("identity", "other")
    assert capsule.remove("identity") and capsule.read("identity") is None


@pytest.mark.parametrize("kind", ["folder", "file"])
def test_semantic_noop_preserves_bytes_and_mtime(tmp_path: Path, kind: str) -> None:
    path = _asset(tmp_path, kind)
    capsule, data = AssetCapsule.from_path(path), CapsuleData(1, {"id": "same"})
    capsule.write("identity", data)
    carrier = path / ".flow/capsules/identity.json" if kind == "folder" else path
    before = carrier.read_bytes(), carrier.stat().st_mtime_ns
    capsule.write("identity", CapsuleData.from_dict(data.to_dict()))
    assert (carrier.read_bytes(), carrier.stat().st_mtime_ns) == before


def test_folder_json_is_exact_and_names_are_independent(tmp_path: Path) -> None:
    folder = _asset(tmp_path, "folder")
    (folder / ".flow").mkdir()
    (folder / ".flow" / "keep.txt").write_text("keep")
    capsule = AssetCapsule.from_path(folder)
    capsule.write("identity", CapsuleData(1, {"id": "x"}))
    assert json.loads((folder / ".flow/capsules/identity.json").read_text()) == {
        "data": {"id": "x"}, "version": 1,
    }
    assert (folder / ".flow/keep.txt").read_text() == "keep"


@pytest.mark.parametrize("raw", ['{"version":1,"version":2,"data":{}}', "[]", "{"])
def test_folder_corruption_fails_closed(tmp_path: Path, raw: str) -> None:
    folder = _asset(tmp_path, "folder")
    target = folder / ".flow/capsules/identity.json"
    target.parent.mkdir(parents=True)
    target.write_text(raw)
    with pytest.raises((DuplicateCapsuleError, MalformedCapsuleError)):
        AssetCapsule.from_path(folder).read("identity")


def test_markdown_capsule_preserves_frontmatter_bom_and_crlf(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    original = b"\xef\xbb\xbf---\r\nname: A\r\n---\r\n\r\nbody"
    path.write_bytes(original)
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": "x"}))
    written = path.read_bytes()
    assert written.startswith(original)
    assert b"\r\nversion: 1\r\n" in written and written.startswith(b"\xef\xbb\xbf---")


@pytest.mark.parametrize("body", [
    "<!-- flowpad:capsule identity\nversion: 1\ndata: {}\n",
    "flowpad:endcapsule identity -->\n",
    "<!-- flowpad:capsule identity\nversion: 1\ndata: {}\nflowpad:endcapsule other -->\n",
    "<!-- flowpad:capsule identity\nversion: 1\ndata: {}\nflowpad:endcapsule identity -->\n" * 2,
    "<!-- flowpad:capsule identity\nversion: 1\ndata:\n  id: one\n  id: two\nflowpad:endcapsule identity -->\n",
])
def test_markdown_malformed_matrix_fails_closed(tmp_path: Path, body: str) -> None:
    path = tmp_path / "asset.md"
    path.write_text(body)
    with pytest.raises((DuplicateCapsuleError, MalformedCapsuleError)):
        AssetCapsule.from_path(path).read("identity")


def test_snapshot_restore_and_strip_keep_domain_text(tmp_path: Path) -> None:
    path = _asset(tmp_path, "file")
    AssetCapsule.from_path(path).write("identity", CapsuleData(1, {"id": "x"}))
    old = path.read_text()
    restored = restore_capsule_blocks("new body", snapshot_capsule_blocks(old))
    assert "id: x" in restored and strip_capsule_blocks(restored).strip() == "new body"


def test_factory_resolves_symlink_and_rejects_unsupported(tmp_path: Path) -> None:
    target = tmp_path / "target.md"
    target.write_text("body")
    link = tmp_path / "link.md"
    link.symlink_to(target)
    AssetCapsule.from_path(link).write("identity", CapsuleData(1, {"id": "x"}))
    assert link.is_symlink() and "id: x" in target.read_text()
    binary = tmp_path / "asset.bin"
    binary.write_bytes(b"x")
    with pytest.raises(UnsupportedCapsuleFormatError):
        AssetCapsule.from_path(binary)


def test_factory_folder_symlink_missing_and_dangling_matrix(tmp_path: Path) -> None:
    folder = tmp_path / "folder"
    folder.mkdir()
    link = tmp_path / "folder-link"
    link.symlink_to(folder, target_is_directory=True)
    AssetCapsule.from_path(link).write("identity", CapsuleData(1, {"id": "x"}))
    assert link.is_symlink() and AssetCapsule.from_path(folder).read("identity").data == {"id": "x"}
    with pytest.raises(FileNotFoundError):
        AssetCapsule.from_path(tmp_path / "missing.md")
    dangling = tmp_path / "dangling.md"
    dangling.symlink_to(tmp_path / "gone.md")
    with pytest.raises(FileNotFoundError):
        AssetCapsule.from_path(dangling)


def test_folder_sidecar_symlink_is_rejected(tmp_path: Path) -> None:
    folder = _asset(tmp_path, "folder")
    outside = tmp_path / "outside"
    outside.mkdir()
    (folder / ".flow").mkdir()
    (folder / ".flow/capsules").symlink_to(outside, target_is_directory=True)
    with pytest.raises(MalformedCapsuleError):
        AssetCapsule.from_path(folder).write("identity", CapsuleData(1, {"id": "x"}))


@pytest.mark.parametrize("component", [".flow", ".flow/capsules/identity.json"])
def test_folder_rejects_every_writable_sidecar_symlink(tmp_path: Path, component: str) -> None:
    folder = _asset(tmp_path, "folder")
    outside = tmp_path / "outside"
    if component == ".flow":
        outside.mkdir()
        (folder / component).symlink_to(outside, target_is_directory=True)
    else:
        target = folder / component
        target.parent.mkdir(parents=True)
        outside.write_text("{}")
        target.symlink_to(outside)
    with pytest.raises(MalformedCapsuleError):
        AssetCapsule.from_path(folder).write("identity", CapsuleData(1, {"id": "x"}))


def test_markdown_update_remove_preserves_unrelated_bytes(tmp_path: Path) -> None:
    path = _asset(tmp_path, "file")
    capsule = AssetCapsule.from_path(path)
    capsule.write("identity", CapsuleData(1, {"id": "one"}))
    capsule.write("review", CapsuleData(1, {"state": "open"}))
    review = snapshot_capsule_blocks(path.read_text())[1]
    capsule.write("identity", CapsuleData(1, {"id": "two"}))
    assert snapshot_capsule_blocks(path.read_text())[1] == review
    assert capsule.remove("identity")
    text = path.read_text()
    assert strip_capsule_blocks(text).strip().endswith("body") and review in text


def test_markdown_no_final_newline_and_terminator_injection(tmp_path: Path) -> None:
    path = tmp_path / "asset.markdown"
    path.write_text("body", encoding="utf-8")
    capsule = AssetCapsule.from_path(path)
    capsule.write("identity", CapsuleData(1, {"id": "x"}))
    assert capsule.read("identity").data == {"id": "x"}
    with pytest.raises(MalformedCapsuleError):
        capsule.write("review", CapsuleData(1, {"text": "break --> comment"}))


def test_names_validates_every_block_not_only_requested_one(tmp_path: Path) -> None:
    path = tmp_path / "asset.md"
    path.write_text(
        "<!-- flowpad:capsule identity\nversion: 1\ndata: {}\n"
        "flowpad:endcapsule identity -->\n\n"
        "<!-- flowpad:capsule review\nversion: [\nflowpad:endcapsule review -->\n"
    )
    capsule = AssetCapsule.from_path(path)
    assert capsule.read("identity") == CapsuleData(1, {})
    with pytest.raises(MalformedCapsuleError):
        capsule.names()


@pytest.mark.parametrize("kind", ["folder", "file"])
def test_threads_observe_one_write_if_absent_winner(tmp_path: Path, kind: str) -> None:
    folder = _asset(tmp_path, kind)
    def write(i: int) -> str:
        return AssetCapsule.from_path(folder).write_if_absent("identity", CapsuleData(1, {"id": str(i)})).data["id"]
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert len(set(pool.map(write, range(24)))) == 1


def test_processes_observe_one_write_if_absent_winner(tmp_path: Path) -> None:
    folder = _asset(tmp_path, "folder")
    code = """from pathlib import Path
import sys
from flow_sdk.capsules import AssetCapsule, CapsuleData
print(AssetCapsule.from_path(Path(sys.argv[1])).write_if_absent('identity', CapsuleData(1, {'id': sys.argv[2]})).data['id'])
"""
    procs = [subprocess.Popen([sys.executable, "-c", code, str(folder), str(i)], stdout=subprocess.PIPE, text=True) for i in range(2)]
    assert len({proc.communicate()[0].strip() for proc in procs}) == 1


def test_fenced_code_is_quoted_text_not_a_capsule(tmp_path):
    """A document ABOUT capsules shows the grammar inside a code fence; the
    scanner must treat that as prose, so the document stays indexable and its
    own real block (outside any fence) is still found."""
    from flow_sdk.capsules import AssetCapsule, CapsuleData

    path = tmp_path / "doc.md"
    path.write_text(
        "# Capsules\n\n```markdown\n<!-- flowpad:capsule identity\nversion: 1\ndata:\n  id: <uuid>\n"
        "flowpad:endcapsule identity -->\n```\n\nand a source-file example in a second fence:\n\n"
        "```python\n# flowpad:capsule tag\n# flowpad:endcapsule tag\n```\n",
        encoding="utf-8",
    )
    capsule = AssetCapsule.from_path(path)
    assert capsule.read("identity") is None
    capsule.write("identity", CapsuleData(1, {"id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}))
    assert capsule.read("identity").data["id"] == "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def test_a_prose_mention_of_the_grammar_is_not_a_marker(tmp_path):
    """A plan or doc that says `<!-- flowpad:capsule identity … -->` mid-sentence
    is prose; only a line that starts as a marker and fails is malformed."""
    from flow_sdk.capsules import AssetCapsule, MalformedCapsuleError
    import pytest

    path = tmp_path / "plan.md"
    path.write_text("Today the id is an appended `<!-- flowpad:capsule identity ... -->` block.\n", encoding="utf-8")
    assert AssetCapsule.from_path(path).read("identity") is None
    path.write_text("<!-- flowpad:capsule identity\nversion: 1\n", encoding="utf-8")  # a real, broken marker
    with pytest.raises(MalformedCapsuleError):
        AssetCapsule.from_path(path).read("identity")
