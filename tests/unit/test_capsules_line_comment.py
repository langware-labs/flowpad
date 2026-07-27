"""Line-comment capsule carrier — tag capsules in source files.

Same grammar/payload as the markdown carrier, each line prefixed with the
language's comment leader. Contract: roundtrip, in-place replace, dispatch.
"""

import pytest

from flow_sdk.capsules import AssetCapsule
from flow_sdk.capsules.data import CapsuleData
from flow_sdk.capsules.errors import UnsupportedCapsuleFormatError
from flow_sdk.capsules.line_comment import LineCommentCapsule

PAYLOAD = CapsuleData(1, {"tags": {"flow.runs": "Run budgets are enforced here"}})


@pytest.mark.parametrize("suffix,leader", [(".py", "#"), (".ts", "//"), (".jsx", "//")])
def test_roundtrip_per_language(tmp_path, suffix, leader):
    path = tmp_path / f"mod{suffix}"
    path.write_text("def f():\n    return 1\n" if suffix == ".py" else "export const f = 1;\n")

    capsule = AssetCapsule.from_path(path)
    assert isinstance(capsule, LineCommentCapsule)
    capsule.write("tag", PAYLOAD)

    text = path.read_text()
    assert f"{leader} flowpad:capsule tag" in text
    assert f"{leader} flowpad:endcapsule tag" in text
    # Original content untouched, capsule appended.
    assert text.startswith("def f():" if suffix == ".py" else "export const f = 1;")

    read_back = AssetCapsule.from_path(path).read("tag")
    assert read_back is not None
    assert read_back.data == PAYLOAD.data
    assert AssetCapsule.from_path(path).names() == ("tag",)


def test_replace_in_place_and_remove(tmp_path):
    path = tmp_path / "mod.py"
    path.write_text("x = 1\n")
    capsule = AssetCapsule.from_path(path)
    capsule.write("tag", PAYLOAD)
    updated = CapsuleData(1, {"tags": {"flow.runs": "changed", "flow.done": "added"}})
    capsule.write("tag", updated)

    text = path.read_text()
    assert text.count("flowpad:capsule tag") == 1  # replaced, not duplicated
    assert capsule.read("tag").data == updated.data

    assert capsule.remove("tag") is True
    assert capsule.read("tag") is None
    assert "flowpad" not in path.read_text()


def test_write_if_absent_keeps_existing(tmp_path):
    path = tmp_path / "mod.ts"
    path.write_text("const a = 1;\n")
    capsule = AssetCapsule.from_path(path)
    capsule.write("tag", PAYLOAD)
    other = CapsuleData(1, {"tags": {"other.name": "nope"}})
    kept = capsule.write_if_absent("tag", other)
    assert kept.data == PAYLOAD.data


def test_unsupported_suffix_still_raises(tmp_path):
    path = tmp_path / "data.bin"
    path.write_bytes(b"\x00\x01")
    with pytest.raises(UnsupportedCapsuleFormatError):
        AssetCapsule.from_path(path)


def test_markdown_still_dispatches_to_html_comment_carrier(tmp_path):
    from flow_sdk.capsules.code_comment import CodeCommentCapsule

    path = tmp_path / "doc.md"
    path.write_text("# Doc\n")
    assert isinstance(AssetCapsule.from_path(path), CodeCommentCapsule)
