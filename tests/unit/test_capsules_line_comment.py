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
    updated = CapsuleData(1, {"tags": {"flow.runs": "changed", "graph_workflow.done": "added"}})
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


# ── repeatable names + anchored writes ──────────────────────────────────────
# `tag` annotates a position, so one file carries several. Every other name
# stays one-per-file: the identity backend relies on duplicates raising.


def test_repeatability_does_not_leak_past_tag(tmp_path):
    from flow_sdk.capsules.errors import DuplicateCapsuleError

    identity = "# flowpad:capsule identity\n# version: 1\n# data:\n#   id: 1\n# flowpad:endcapsule identity\n"
    path = tmp_path / "dup.py"
    path.write_text(identity + "x = 1\n" + identity)
    with pytest.raises(DuplicateCapsuleError):
        AssetCapsule.from_path(path).read("identity")


def test_identity_resolves_alongside_many_tag_blocks(tmp_path):
    path = tmp_path / "mod.py"
    path.write_text("a = 1\nb = 2\n")
    capsule = LineCommentCapsule(path)
    capsule.write("identity", CapsuleData(1, {"id": "11111111-2222-4333-8444-555555555555"}))
    capsule.write_at("tag", CapsuleData(1, {"tags": {"qa.one": "1"}}), line=1)
    # the second anchor is resolved AFTER the first insert shifted the file
    second = path.read_text().splitlines().index("b = 2") + 1
    capsule.write_at("tag", CapsuleData(1, {"tags": {"qa.two": "2"}}), line=second)

    assert len(capsule.read_all("tag")) == 2
    assert capsule.read("identity").data == {"id": "11111111-2222-4333-8444-555555555555"}
    assert capsule.names() == ("identity", "tag")


@pytest.mark.parametrize("line", [0, -1, 99])
def test_write_at_refuses_an_unusable_anchor(tmp_path, line):
    from flow_sdk.capsules.errors import MalformedCapsuleError

    path = tmp_path / "mod.py"
    path.write_text("x = 1\n")
    with pytest.raises(MalformedCapsuleError):
        LineCommentCapsule(path).write_at("tag", PAYLOAD, line=line)


def test_write_at_refuses_to_split_an_existing_block(tmp_path):
    """Anchoring inside a block would corrupt every later read of the file."""
    from flow_sdk.capsules.errors import MalformedCapsuleError

    path = tmp_path / "mod.py"
    path.write_text("x = 1\n")
    capsule = LineCommentCapsule(path)
    capsule.write_at("tag", PAYLOAD, line=1)
    inside = capsule.read_all("tag")[0].line + 1
    with pytest.raises(MalformedCapsuleError):
        capsule.write_at("tag", PAYLOAD, line=inside)
    assert len(capsule.read_all("tag")) == 1  # refused, and nothing was written
