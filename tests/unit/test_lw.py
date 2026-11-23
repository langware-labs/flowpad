"""lw (langware): statement and requirement blocks in a project's docs (`flow_sdk/lw`, `flow tag tree|check|...`)."""

import json
import threading
from pathlib import Path

from typer.testing import CliRunner

from flow_sdk.cli.commands.tag_cmd import tag_app
from flow_sdk.lw import collection as lw
from flow_sdk.lw.blocks import parse_blocks, render_block, validate
from flow_sdk.schema.data_spec.lw_spec import split_about

REPO = Path(__file__).resolve().parents[2]

DOC = """---
title: Machine access
tags:
- machine_access
- machine_access.connected
- machine_access.connected.build
---
# Machine access

Prose lw never touches.

```statements
tag: machine_access.connected
statements:
  - text: A compute node represents a machine.
    basis: stated
  - text: A machine has one id.
    issues:
      - get_machine_id never reads the override file.
    about:
      - flow_sdk/utils/machine_id.py:29
requirements:
  - text: Remote control holds the connection.
```

```statements
tag: machine_access.connected.build
depends_on:
  - machine_access.connected
statements:
  - text: Remote control starts the worker.
```
"""


def _docs(tmp_path, text=DOC, name="machine_access.md", folder="docs"):
    root = tmp_path / folder
    root.mkdir(parents=True, exist_ok=True)
    (root / name).write_text(text, encoding="utf-8")
    return root


def _messages(root, **kwargs):
    return [p.message for p in lw.check(lw.load(root, **kwargs))]


def _put(root, kind, tag, body, name="machine_access.md"):
    return [p.message for p in lw.put(root / name, kind, tag, body, root)]


def test_a_doc_holds_several_blocks_and_no_issues_means_pass(tmp_path):
    collection = lw.load(_docs(tmp_path))
    assert [(b.kind, b.tag, b.line) for b in collection.blocks] == [
        ("statements", "machine_access.connected", 12),
        ("statements", "machine_access.connected.build", 26),
    ]
    assert [r.text for r in collection.blocks[0].spec.requirements] == ["Remote control holds the connection."]
    first, second = collection.blocks[0].items
    assert first.issues == [] and first.about == []
    assert second.issues == ["get_machine_id never reads the override file."]
    assert split_about(second.about[0]) == ("flow_sdk/utils/machine_id.py", 29)
    assert lw.check(collection) == []


def test_a_block_shown_as_an_example_is_not_a_block(tmp_path):
    example = "# Syntax\n\n````\n```statements\ntag: not.real\nstatements: nope\n```\n````\n"
    assert _messages(_docs(tmp_path, example)) == []


def test_put_adds_a_block_lists_its_tag_and_leaves_the_body_alone(tmp_path):
    root = _docs(tmp_path)
    body = {"depends_on": ["machine_access.connected"], "statements": [{"text": "A node may be locked.", "basis": "stated"}]}
    assert _put(root, "statements", "machine_access.locked", body) == []
    text = (root / "machine_access.md").read_text(encoding="utf-8")
    head, rest = DOC.split("---\n# Machine access")
    assert text == (
        head + "- machine_access.locked\n---\n# Machine access" + rest.rstrip("\n")
        + "\n\n```statements\ntag: machine_access.locked\ndepends_on:\n  - machine_access.connected\n"
        "statements:\n  - text: A node may be locked.\n    basis: stated\n```\n"
    )


def test_put_replaces_the_block_with_the_same_tag(tmp_path):
    root = _docs(tmp_path)
    assert _put(root, "statements", "machine_access.connected", {"statements": [{"text": "One node per machine."}]}) == []
    before, after = DOC.split("```statements")[0], DOC.split("```\n\n```statements")[1]
    assert (root / "machine_access.md").read_text(encoding="utf-8") == (
        before + "```statements\ntag: machine_access.connected\nstatements:\n  - text: One node per machine.\n"
        "```\n\n```statements" + after
    )


def test_a_refused_put_writes_nothing(tmp_path):
    root = _docs(tmp_path)
    refused = [
        ("statements", "Machine Access", {"statements": [{"text": "x"}]}, "tag: "),
        ("statements", "machine_access.x", {"depends_on": ["nobody.has.this"], "statements": [{"text": "x"}]}, "no block or doc has this tag"),
        ("statements", "machine_access.x", {"statements": [{"id": "S1", "text": "x"}]}, "a statement has no id"),
        ("statements", "machine_access.x", {"statements": [{"text": "x", "requirements": ["y"]}]}, "a statement has no requirements"),
        ("statements", "machine_access.x", {"statements": [{"text": "x", "basis": "guessed"}]}, "'stated' or 'proven'"),
        ("statements", "machine_access.x", {"statements": [{"text": "x", "about": ["../x.py"]}]}, "a path inside the project"),
        ("statements", "machine_access.x", {"statements": []}, "at least 1 item"),
        ("statements", "machine_access.x", {"statements": [{"text": "x"}], "extra": 1}, "extra: unknown field"),
        ("statements", "machine_access.x", {"requirements": [{"text": "x"}]}, "statements: Field required"),
        ("statements", "machine_access.x", {"statements": [{"text": "x"}], "requirements": [{"text": "y", "basis": "stated"}]}, "unknown field"),
        ("test_debug", "machine_access.connected", {"statements": [{"text": "x"}]}, "is a statements block here"),
    ]
    assert [p.message for p in lw.put(root, "statements", "a", {"statements": [{"text": "x"}]}, root)] == [
        "the doc does not exist; create it first"  # a folder is not a doc
    ]
    for kind, tag, body, expected in refused:
        messages = _put(root, kind, tag, body)
        assert any(expected in m for m in messages), (tag, body, messages)
        assert (root / "machine_access.md").read_text(encoding="utf-8") == DOC


def test_a_dependency_may_name_a_doc_or_a_block_in_another_doc(tmp_path):
    root = _docs(tmp_path)
    other = "---\ntags: [access_keys]\n---\n\n```statements\ntag: access_keys.passkey\nstatements:\n  - text: A key is a passkey.\n```\n"
    _docs(tmp_path, other, "access_keys.md")
    body = {"depends_on": ["access_keys", "access_keys.passkey"], "statements": [{"text": "A lock needs a key."}]}
    assert _put(root, "statements", "machine_access.locked", body) == []


def test_another_projects_tag_is_looked_up_in_that_project(tmp_path):
    root = _docs(tmp_path)
    other = "```statements\ntag: orders.created\nstatements:\n  - text: An order has one owner.\n```\n"
    acme = _docs(tmp_path, other, "orders.md", folder="acme/docs")
    block = "```statements\ntag: billing\ndepends_on: [--acme--.orders.created]\nstatements:\n  - text: A bill follows an order.\n```\n"
    _docs(tmp_path, block, "billing.md")
    assert _messages(root) == ["depends_on '--acme--.orders.created': the package 'acme' is not known here"]
    assert _messages(root, packages={"acme": acme.parent}) == []
    (root / "billing.md").write_text(block.replace("orders.created", "orders.gone"), encoding="utf-8")
    assert _messages(root, packages={"acme": acme.parent}) == [
        "depends_on '--acme--.orders.gone': the package 'acme' has no block or doc with this tag"
    ]


def test_check_names_a_duplicate_tag_and_a_cycle(tmp_path):
    root = _docs(tmp_path)
    again = "```statements\ntag: machine_access.connected\nstatements:\n  - text: Said twice.\n```\n"
    _docs(tmp_path, again, "twice.md")
    assert any("is already used at" in m for m in _messages(root))
    (root / "twice.md").unlink()
    loop = (
        "```statements\ntag: loop.a\ndepends_on: [loop.b]\nstatements:\n  - text: a\n```\n\n"
        "```statements\ntag: loop.b\ndepends_on: [loop.a]\nstatements:\n  - text: b\n```\n"
    )
    _docs(tmp_path, loop, "loop.md")
    assert _messages(root) == ["dependency cycle: loop.a -> loop.b -> loop.a"]


def test_the_tree_lists_a_shared_dependency_under_each_user(tmp_path):
    root = _docs(tmp_path)
    more = (
        "```statements\ntag: locked\ndepends_on: [machine_access.connected]\nstatements:\n  - text: a\n```\n\n"
        "```statements\ntag: remote\ndepends_on: [locked, machine_access.connected]\nstatements:\n  - text: b\n```\n"
    )
    _docs(tmp_path, more, "more.md")
    rows = [(depth, tag) for depth, tag, _block, _repeated in lw.tree(lw.load(root), "remote")]
    assert rows == [(0, "remote"), (1, "locked"), (2, "machine_access.connected"), (1, "machine_access.connected")]
    assert lw.tree(lw.load(root), "nobody.has.this") == []


def test_related_walks_dependencies_and_dependents(tmp_path):
    collection = lw.load(_docs(tmp_path))
    assert [b.tag for b in lw.related(collection, "machine_access.connected.build")] == [
        "machine_access.connected.build", "machine_access.connected",
    ]
    assert [b.tag for b in lw.related(collection, "machine_access.connected", dependents=True)] == [
        "machine_access.connected", "machine_access.connected.build",
    ]


def test_remove_deletes_one_block_unless_another_depends_on_it(tmp_path):
    root = _docs(tmp_path)
    doc = root / "machine_access.md"
    assert [p.message for p in lw.remove(doc, "machine_access.connected", root)] == [
        "still depended on by: machine_access.connected.build"
    ]
    assert doc.read_text(encoding="utf-8") == DOC
    assert lw.remove(doc, "machine_access.connected.build", root) == []
    assert doc.read_text(encoding="utf-8") == DOC[:DOC.index("\n```statements\ntag: machine_access.connected.build")]
    assert [p.message for p in lw.remove(doc, "machine_access.connected.build", root)] == [
        "no block has the tag 'machine_access.connected.build' in this doc"
    ]


def test_a_long_sentence_stays_on_one_line(tmp_path):
    root = _docs(tmp_path)
    long = ("A sentence long enough that a YAML writer with a narrow width would fold it over two lines, " * 2).strip()
    assert _put(root, "statements", "machine_access.long", {"statements": [{"text": long}]}) == []
    assert f"  - text: {long}\n" in (root / "machine_access.md").read_text(encoding="utf-8")


def test_the_command_line_reports_and_exits_non_zero_on_a_problem(tmp_path):
    root = _docs(tmp_path)
    run = CliRunner().invoke
    done = run(tag_app, ["check", "--root", str(root)])
    assert done.exit_code == 0 and "OK: 2 blocks, 0 problems" in done.output
    bad = run(tag_app, ["put", "--doc", str(root / "machine_access.md"), "--kind", "statements", "--tag", "machine_access.x",
                       "--json", '{"statements": [{"id": "S1", "text": "x"}]}', "--root", str(root)])
    assert bad.exit_code == 1 and "a statement has no id" in bad.output and "REFUSED: nothing written" in bad.output
    shown = run(tag_app, ["show", "machine_access", "--root", str(root)])  # a doc tag: every block of the doc
    assert shown.exit_code == 0 and shown.output.count("```statements") == 2 and shown.output.count("requirements:") == 1
    listed = run(tag_app, ["blocks", "--root", str(root)])
    assert "statements " in listed.output and "1 docs, 2 blocks" in listed.output
    tree = run(tag_app, ["tree", "machine_access.connected.build", "--root", str(root)])
    assert tree.output.splitlines()[1].startswith("  machine_access.connected  statements (2)")
    assert run(tag_app, ["tree", "nobody.has.this", "--root", str(root)]).exit_code == 1
    doc_tree = run(tag_app, ["tree", "machine_access", "--root", str(root)]).output.splitlines()
    assert doc_tree[0] == "machine_access" and doc_tree[1].startswith("  machine_access.connected  statements")
    (root / "empty.md").write_text("---\ntags: [empty_doc]\n---\n# Empty\n", encoding="utf-8")
    empty = run(tag_app, ["show", "empty_doc", "--root", str(root)])
    assert empty.exit_code == 0 and "holds no blocks yet" in empty.output


def test_block_validity_agrees_with_the_app(tmp_path):
    """The shared fixture, also read by ui/tests/unit/lw-schema.test.ts."""
    for case in json.loads((REPO / "tests/fixtures/lw_blocks_contract.json").read_text(encoding="utf-8"))["cases"]:
        spec, problems = validate(case["kind"], case["body"])
        assert (spec is not None) == case["ok"], (case["name"], problems)
        assert bool(problems) != case["ok"], case["name"]


_BODY = "tag: t\nstatements:\n  - text: x\n"
_FENCES = {
    "backticks": ("```statements\n" + _BODY + "```\n", 1),
    "tildes": ("~~~statements\n" + _BODY + "~~~\n", 1),
    "a longer fence": ("````statements\n" + _BODY + "````\n", 1),
    "indented three spaces": ("   ```statements\n   tag: t\n   statements:\n     - text: x\n   ```\n", 1),
    "inside a list item": ("- item\n\n  ```statements\n  tag: t\n  statements:\n    - text: x\n  ```\n", 1),
    "CRLF line ends": ("```statements\r\ntag: t\r\nstatements:\r\n  - text: x\r\n```\r\n", 1),
    "inside an example fence": ("````\n```statements\n" + _BODY + "```\n````\n", 0),
    "inside a markdown example": ("```md\n```statements\n" + _BODY + "```\n", 0),
    "never closed": ("```statements\n" + _BODY, 0),
    "indented four spaces": ("    ```statements\n    tag: t\n    ```\n", 0),
    "another language": ("```Statements\n" + _BODY + "```\n", 0),
}


def test_a_block_is_what_a_markdown_reader_sees_as_one():
    for name, (text, expected) in _FENCES.items():
        valid = [b for b in parse_blocks(text, Path("x.md")) if b.spec is not None]
        assert len(valid) == expected, name


def test_put_keeps_the_line_ends_and_the_indent_of_the_doc(tmp_path):
    root = _docs(tmp_path, "placeholder")
    doc = root / "machine_access.md"
    doc.write_bytes(b"# T\r\n\r\n- item\r\n\r\n  ```statements\r\n  tag: a\r\n  statements:\r\n    - text: old\r\n  ```\r\n")
    assert _put(root, "statements", "a", {"statements": [{"text": "new"}]}) == []
    raw = doc.read_bytes()
    assert b"\n" not in raw.replace(b"\r\n", b"")
    assert b"  ```statements\r\n  tag: a\r\n  statements:\r\n    - text: new\r\n  ```\r\n" in raw


def test_two_writers_of_one_doc_lose_nothing(tmp_path):
    root = _docs(tmp_path, "# T\n")
    workers = [
        threading.Thread(target=_put, args=(root, "statements", f"t{i}", {"statements": [{"text": "x"}]}))
        for i in range(8)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    assert sorted(b.tag for b in lw.load(root).blocks) == [f"t{i}" for i in range(8)]


def test_a_chain_deeper_than_the_call_stack_and_a_wide_diamond(tmp_path):
    chain = "\n".join(
        f"```statements\ntag: c{i}\n" + (f"depends_on: [c{i - 1}]\n" if i else "") + "statements:\n  - text: x\n```\n"
        for i in range(1500)
    )
    diamond = "\n".join(
        f"```statements\ntag: l{layer}{side}\n" + (f"depends_on: [l{layer - 1}a, l{layer - 1}b]\n" if layer else "")
        + "statements:\n  - text: x\n```\n"
        for layer in range(20) for side in "ab"
    )
    root = _docs(tmp_path, chain, "chain.md")
    _docs(tmp_path, diamond, "diamond.md")
    collection = lw.load(root)
    assert lw.check(collection) == []
    assert len(lw.tree(collection, "c1499")) == 1500
    rows = lw.tree(collection, "l19a")
    # 1 root + 38 tags below it, each expanded once + 36 later uses, listed without their own tree.
    assert len(rows) == 75
    assert sum(1 for *_rest, repeated in rows if repeated) == 34  # the two bottom tags have nothing to repeat


def test_a_file_that_is_not_utf8_and_an_ignored_folder_do_not_break_the_check(tmp_path):
    root = _docs(tmp_path)
    (root / "binary.md").write_bytes(b"\xff\xfe\x00```statements\n\xff\n```\n")
    (root / "node_modules" / "pkg").mkdir(parents=True)
    (root / "node_modules" / "pkg" / "README.md").write_text("```statements\ntag: junk\nstatements:\n  - text: x\n```\n")
    collection = lw.load(root)
    assert "junk" not in collection.by_tag()
    assert [p.message for p in lw.check(collection) if p.path.name == "machine_access.md"] == []
    assert [p.message for p in lw.put(root / "binary.md", "statements", "b", {"statements": [{"text": "x"}]}, root)] == [
        "the doc is not valid UTF-8"
    ]


def test_the_repo_docs_pass_the_check():
    problems = lw.check(lw.load(REPO / "docs"))
    assert problems == [], "\n".join(str(p) for p in problems)


def test_a_test_debug_block_is_written_in_its_field_order_and_can_be_depended_on(tmp_path):
    doc = tmp_path / "rules.md"
    doc.write_text("# Rules\n")
    body = {
        "statements": [{"text": "A frame stays on screen for at least 500 ms.", "about": ["ui/src/a.tsx"]}],
        "proven": "2026-08-13 · FLOWPAD-1980",
        "sites": [{"rel_path": "ui/tests/unit/a.test.tsx", "line": 49, "note": "FAILING? read this tag's rules"}],
    }
    assert lw.put(doc, "test_debug", "breadcrumb.test.a.rules", body, tmp_path) == []
    block = parse_blocks(doc.read_text(), doc)[0]
    assert block.kind == "test_debug" and len(block.items) == 1
    keys = [line.split(":")[0] for line in render_block(block.spec).splitlines() if line[:1].isalpha()]
    assert keys == ["tag", "sites", "proven", "statements"]
    follows = {"depends_on": ["breadcrumb.test.a.rules"], "statements": [{"text": "The frame is held."}]}
    assert lw.put(doc, "statements", "breadcrumb.test.a.follows", follows, tmp_path) == []
    assert lw.check(lw.load(tmp_path)) == []


def test_a_doc_is_named_by_the_tag_in_its_header(tmp_path):
    (tmp_path / "a.md").write_text("---\ntag: access_keys\n---\n# Access keys\n")
    (tmp_path / "b.md").write_text(
        "---\ntag: machine_access\ndepends_on:\n  - access_keys\n---\n"
        "```statements\ntag: machine_access.model\nstatements:\n  - text: x\n```\n"
    )
    assert lw.check(lw.load(tmp_path)) == []
