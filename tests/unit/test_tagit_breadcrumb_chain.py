"""The tagit breadcrumb chain — a failing test points at its own rules.

A `tag` capsule sits on top of a failing test; its tag resolves to a rules doc
that holds exactly the fact needed to fix the failure. The test walks that chain
end to end with NO model in the loop: find the capsule, read the rules, apply
them, watch the failure go green. If the chain is ever less than actionable,
these assertions break.

Pure Python — no server, no DB, no subprocess. The generated test is executed by
`exec` into a throwaway namespace, so there is no import-system state to reset.
The DB-backed half of the join (frontmatter `tags:` → entity rows → the
`/api/v1/tags/context` response) is covered by tests/api/test_tag_context_route.py.
"""

import hashlib
import re

import pytest

from flow_sdk.capsules.data import CapsuleData
from flow_sdk.capsules.line_comment import LineCommentCapsule
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.tags.bindings import scan_code_capsules

TAG = "breadcrumb.test.catchup_login.rules"
SECRET = "correct-value"
DIGEST = hashlib.sha256(SECRET.encode()).hexdigest()
NOTE = "FAILING? the hashed input is in this tag's rules doc — use it, never edit EXPECTED"

# The failure under test: the right expected digest, the wrong input.
FAILING_TEST = f'''import hashlib

SECRET = "wrong-value"
EXPECTED = "{DIGEST}"


def test_secret_hash():
    assert hashlib.sha256(SECRET.encode()).hexdigest() == EXPECTED
'''

# The rules doc is the only place the input value is written down.
RULES_DOC = f"""---
title: Catchup login secret
tags: [{TAG}]
description: The catchup digest is taken over `{SECRET}`; EXPECTED is ground truth.
---
# Catchup login secret

> Ground truth. Do not edit without the user's approval.

## Expected behavior

Hash the value `{SECRET}` — that is the only input the digest was ever taken
over. EXPECTED is ground truth: never edit it to match whatever the code
currently produces.
"""


def _def_line(path, function: str) -> int:
    """1-indexed line of a module-level ``def``."""
    return next(
        index for index, line in enumerate(path.read_text().splitlines(), 1) if line.startswith(f"def {function}")
    )


def _run(path, function: str) -> None:
    """Execute the generated test in a throwaway namespace."""
    namespace: dict = {}
    exec(compile(path.read_text(), str(path), "exec"), namespace)  # noqa: S102
    namespace[function]()


@pytest.fixture()
def breadcrumbed(tmp_path):
    """A failing test with a breadcrumb capsule, plus the rules doc it names."""
    test_path = tmp_path / "test_secret_hash.py"
    test_path.write_text(FAILING_TEST)

    docs = tmp_path / "docs"
    docs.mkdir()
    doc_path = docs / "catchup-login.md"
    doc_path.write_text(RULES_DOC)

    anchor = _def_line(test_path, "test_secret_hash")
    LineCommentCapsule(test_path).write_at("tag", CapsuleData(1, {"tags": {TAG: NOTE}}), line=anchor)
    return test_path, doc_path, anchor


def test_breadcrumb_chain_is_actionable(tmp_path, breadcrumbed):
    test_path, doc_path, anchor = breadcrumbed

    # 1. the test fails as written
    with pytest.raises(AssertionError):
        _run(test_path, "test_secret_hash")

    # 2. the capsule landed ON TOP of the def, at column 0, and touched nothing
    #    else — an indented or reflowed block would make the file unreadable to
    #    the scanner without raising anywhere.
    block = LineCommentCapsule(test_path).read_all("tag")[0]
    lines = test_path.read_text().splitlines()
    assert block.line == anchor
    assert lines[block.line - 1] == "# flowpad:capsule tag"
    assert lines[block.end_line - 1] == "# flowpad:endcapsule tag"
    assert lines[block.end_line].startswith("def test_secret_hash")
    kept = [line for i, line in enumerate(lines, 1) if not block.line <= i <= block.end_line]
    assert "\n".join(kept) + "\n" == FAILING_TEST

    # 3. the agent finds the breadcrumb by scanning the root
    sites = scan_code_capsules(tmp_path, TAG)
    assert len(sites) == 1
    assert sites[0] == {"path": "test_secret_hash.py", "line": anchor, "tags": {TAG: NOTE}}

    # 4. every ancestor query reaches it too; a sibling family does not
    assert scan_code_capsules(tmp_path, "breadcrumb.test") == sites
    assert scan_code_capsules(tmp_path, "breadcrumb") == sites
    assert scan_code_capsules(tmp_path, "breadcrumb.other") == []

    # 5. the doc is bound to the same tag through the production parser
    from flow_sdk.fs_store.fs_ref import FSRef

    records = SchemaRegistry.get("markdown").from_disk_fn(FSRef(doc_path), "")
    assert records, "the rules doc should parse into a record"
    assert records[0].tags == [TAG]

    # 6. the agent's move: take the value the rules name, apply it
    rules = doc_path.read_text()
    value = re.search(r"Hash the value `([^`]+)`", rules).group(1)
    test_path.write_text(test_path.read_text().replace('SECRET = "wrong-value"', f'SECRET = "{value}"'))

    # 7. green — the rules doc carried everything the fix needed
    _run(test_path, "test_secret_hash")

    # 8. and the breadcrumb survived the repair
    assert scan_code_capsules(tmp_path, TAG) == sites


def test_two_breadcrumbs_in_one_file(tmp_path):
    """`tag` is repeatable: each breadcrumb stays on its own test."""
    path = tmp_path / "test_pair.py"
    path.write_text("def test_one():\n    assert True\n\n\ndef test_two():\n    assert True\n")

    capsule = LineCommentCapsule(path)
    capsule.write_at(
        "tag",
        CapsuleData(1, {"tags": {"breadcrumb.test.one.rules": "read one"}}),
        line=_def_line(path, "test_one"),
    )
    capsule.write_at(
        "tag",
        CapsuleData(1, {"tags": {"breadcrumb.test.two.rules": "read two"}}),
        line=_def_line(path, "test_two"),
    )

    blocks = capsule.read_all("tag")
    assert len(blocks) == 2
    assert blocks[0].line < blocks[1].line
    assert capsule.names() == ("tag",)  # distinct names, not one per block

    lines = path.read_text().splitlines()
    assert lines[blocks[0].end_line].startswith("def test_one")
    assert lines[blocks[1].end_line].startswith("def test_two")

    # the scan reports one site PER BLOCK, each at its own line
    sites = scan_code_capsules(tmp_path, "breadcrumb.test")
    assert [site["line"] for site in sites] == [block.line for block in blocks]
    assert [site["tags"] for site in sites] == [
        {"breadcrumb.test.one.rules": "read one"},
        {"breadcrumb.test.two.rules": "read two"},
    ]

    # a leaf query selects exactly its own block
    assert scan_code_capsules(tmp_path, "breadcrumb.test.two.rules") == [sites[1]]


def test_rerunning_the_same_anchor_never_stacks_blocks(tmp_path):
    """Re-running tagit on a test it already breadcrumbed replaces in place."""
    path = tmp_path / "test_solo.py"
    path.write_text("def test_solo():\n    assert True\n")
    capsule = LineCommentCapsule(path)
    payload = CapsuleData(1, {"tags": {"breadcrumb.test.solo.rules": "first"}})
    capsule.write_at("tag", payload, line=_def_line(path, "test_solo"))

    # identical re-run — byte- and mtime-preserving no-op
    before = path.stat().st_mtime_ns
    capsule.write_at("tag", payload, line=_def_line(path, "test_solo"))
    assert path.stat().st_mtime_ns == before
    assert len(capsule.read_all("tag")) == 1

    # an extended payload rewrites that one block rather than adding another
    capsule.write_at(
        "tag",
        CapsuleData(1, {"tags": {"breadcrumb.test.solo.rules": "first", "breadcrumb.test.solo2.rules": "second"}}),
        line=_def_line(path, "test_solo"),
    )
    blocks = capsule.read_all("tag")
    assert len(blocks) == 1
    assert set(blocks[0].data.data["tags"]) == {
        "breadcrumb.test.solo.rules",
        "breadcrumb.test.solo2.rules",
    }
    assert path.read_text().splitlines()[blocks[0].end_line].startswith("def test_solo")

    # removing the breadcrumb restores the original file exactly
    assert capsule.remove("tag") is True
    assert path.read_text() == "def test_solo():\n    assert True\n"
