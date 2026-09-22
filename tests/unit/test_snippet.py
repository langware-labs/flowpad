"""Snippet infra, pure code: parse/save byte-exactness, and running real code.

Runs real interpreters (python3, node, rustc) found on the terminal's PATH, the
same lookup the product does. python3 is required; a missing node or rustc is a
skip that names the tool.
"""

from __future__ import annotations

import asyncio
import os
import random
import shutil
import tempfile
import time
from pathlib import Path

import pytest

from flow_sdk.core.snippet import (
    RUNNERS,
    SnippetDoc,
    edit_region,
    read_snippet,
    run_snippet,
    stop_runs_of,
    stop_snippet,
    write_temp_snippet,
)
from flow_sdk.core.capabilities.env_probe import capture_terminal_path

M = {"hidden": "# %% flowpad:hidden", "init": "# %% flowpad:init", "snippet": "# %% flowpad:snippet"}


# ── parse / text ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    [
        "# %% flowpad:snippet",
        "# %% flowpad:snippet\n",
        "# %% flowpad:snippet\nprint(1)",
        "# %% flowpad:snippet\nprint(1)\n",
        "#!/usr/bin/env python3\n# %% flowpad:hidden\nimport os\n# %% flowpad:snippet\nx\n",
        "# %% flowpad:hidden\n# %% flowpad:init\n# %% flowpad:snippet\n",  # empty regions
        "# %% flowpad:hidden\n\n# %% flowpad:snippet\n\n\n",  # one empty line vs none
        "# %% flowpad:hidden\r\nimport os\r\n# %% flowpad:snippet\r\nprint(1)\r\n",  # CRLF
        "a\r\n# %% flowpad:snippet\nb\r\nc\n",  # mixed endings
        "// %% flowpad:hidden\nconst fs = require('fs');\n// %% flowpad:snippet\nconsole.log(1)\n",
        "-- %% flowpad:init\nselect 1;\n-- %% flowpad:snippet\nselect 2;",
        "   #   %%   flowpad:snippet   trailing words\nx",
        "# %% flowpad:snippet\na\n# %% flowpad:snippet\nb\n",  # repeated kinds
        "\n\n# %% flowpad:snippet\nx",
    ],
)
def test_round_trip_is_byte_exact(text):
    doc = SnippetDoc.parse(text)
    assert doc is not None
    assert doc.text() == text


@pytest.mark.parametrize(
    "text",
    [
        "",
        "print(1)\n",
        "# %% flowpad:other\nx",  # unknown kind
        "#%%flowpad:snippetx\n",  # not a word boundary
        "x = '# %% flowpad:snippet'\n",  # inside a string, not at line start
        "# flowpad:snippet\n",  # no %%
        "print(1) # %% flowpad:snippet\n",
    ],
)
def test_not_a_snippet(text):
    assert SnippetDoc.parse(text) is None


def test_a_marker_without_spaces_still_counts():
    doc = SnippetDoc.parse("#%%flowpad:snippet\nx")
    assert doc is not None and doc.regions[0].kind == "snippet"


def test_regions_hold_what_the_viewer_shows():
    doc = SnippetDoc.parse("import sys\n# %% flowpad:hidden\nimport json\n# %% flowpad:init\nd = 1\n# %% flowpad:snippet\nprint(d)\n")
    assert [(r.kind, r.body) for r in doc.regions] == [
        ("hidden", "import sys\n"),  # before the first marker: revealable with the imports
        ("hidden", "import json\n"),
        ("init", "d = 1\n"),
        ("snippet", "print(d)\n"),
    ]


def _random_doc(rng: random.Random) -> str:
    newline = rng.choice(["\n", "\r\n"])
    lines = []
    if rng.random() < 0.3:
        lines.append(rng.choice(["#!/usr/bin/env python3", "", "import sys"]))
    for _ in range(rng.randint(1, 6)):
        lines.append(rng.choice(list(M.values())))
        for _ in range(rng.randint(0, 4)):
            lines.append(rng.choice(["", "x = 1", "    y = '%%'", "# comment", "print('# %% flowpad:snippet')", "\t"]))
    text = newline.join(lines)
    return text + (newline if rng.random() < 0.5 else "")


def test_stress_round_trip_5000_random_documents():
    rng = random.Random(1234)
    for _ in range(5000):
        text = _random_doc(rng)
        doc = SnippetDoc.parse(text)
        assert doc is not None, text
        assert doc.text() == text, text


def test_stress_edit_one_region_changes_only_that_region():
    rng = random.Random(99)
    for _ in range(2000):
        text = _random_doc(rng)
        doc = SnippetDoc.parse(text)
        i = rng.randrange(len(doc.regions))
        new_body = rng.choice(["", "\n", "z = 2", "z = 2\nw = 3", "z\n\n", "a\r\nb"])
        edited = SnippetDoc.parse(doc.with_body(i, doc.regions[i].kind, new_body).text())
        assert edited is not None
        assert len(edited.regions) == len(doc.regions), (text, i, new_body)
        for j, (a, b) in enumerate(zip(doc.regions, edited.regions)):
            assert a.kind == b.kind
            if j != i:
                assert a.body == b.body and a.marker == b.marker
        last_unclosed = i == len(doc.regions) - 1 and not doc.regions[i].body.endswith("\n")
        # The one lossy case: typing a newline at the very end of a file that had
        # none makes it the file's final newline.
        expected = new_body.removesuffix("\n") if last_unclosed else new_body
        # Written in the file's own ending, so compare ending-blind.
        assert edited.regions[i].shown.replace("\r\n", "\n") == expected.replace("\r\n", "\n"), (text, i, new_body)
        if doc.regions[i].eol == "\r\n":
            assert "\n" not in edited.regions[i].body.replace("\r\n", "")


def test_code_before_the_first_marker_edits_like_any_region(tmp_path):
    """The agent put `use ...;` above the first marker: it must be revealable and
    editable, and the file must stay byte-exact around it (CRLF too)."""
    for nl in ("\n", "\r\n"):
        path = tmp_path / "lead.rs"
        text = f"use std::collections::HashMap;{nl}// %% flowpad:snippet{nl}fn main() {{}}{nl}"
        path.write_bytes(text.encode())
        doc = read_snippet(path)
        assert [(r.kind, r.marker) for r in doc.regions] == [("hidden", ""), ("snippet", f"// %% flowpad:snippet{nl}")]
        edit_region(path, 0, "hidden", "use std::collections::HashMap;\nuse std::fmt;")
        assert path.read_bytes().decode() == f"use std::collections::HashMap;{nl}use std::fmt;{nl}// %% flowpad:snippet{nl}fn main() {{}}{nl}"


def test_an_edit_that_drops_the_newline_does_not_eat_the_next_marker():
    doc = SnippetDoc.parse("# %% flowpad:hidden\nimport os\n# %% flowpad:snippet\nx\n")
    assert doc.with_body(0, "hidden", "import sys").text() == "# %% flowpad:hidden\nimport sys\n# %% flowpad:snippet\nx\n"


def test_with_body_refuses_a_stale_position():
    doc = SnippetDoc.parse("# %% flowpad:hidden\na\n# %% flowpad:snippet\nb\n")
    with pytest.raises(ValueError):
        doc.with_body(0, "snippet", "x")
    with pytest.raises(ValueError):
        doc.with_body(5, "snippet", "x")


def test_save_writes_only_the_edited_bytes(tmp_path):
    path = tmp_path / "s.py"
    original = "# %% flowpad:hidden\r\nimport os\r\n# %% flowpad:snippet\r\nprint(1)\r\n"
    path.write_bytes(original.encode())
    edit_region(path, 1, "snippet", "print(2)")
    assert path.read_bytes() == original.replace("print(1)", "print(2)").encode()


def test_concurrent_edits_to_different_regions_all_land(tmp_path):
    """50 threads, each editing its own region of one file: no edit is lost."""
    import threading  # noqa: PLC0415

    n = 50
    path = tmp_path / "many.py"
    path.write_text("".join(f"# %% flowpad:snippet\nv{i} = 0\n" for i in range(n)))
    barrier = threading.Barrier(n)

    def worker(i: int) -> None:
        barrier.wait()
        edit_region(path, i, "snippet", f"v{i} = {i}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r.shown for r in read_snippet(path).regions] == [f"v{i} = {i}" for i in range(n)]


def test_an_edit_made_against_stale_text_does_not_erase_the_other_writer(tmp_path):
    """The viewer loaded `x = 1`; the agent then wrote `x = 2`. Saving the
    viewer's edit would silently throw the agent's change away."""
    path = tmp_path / "s.py"
    path.write_text("# %% flowpad:snippet\nx = 1\n")
    path.write_text("# %% flowpad:snippet\nx = 2\n")  # the agent's change
    with pytest.raises(ValueError):
        edit_region(path, 0, "snippet", "x = 1\nprint(x)", base="x = 1")
    assert path.read_text() == "# %% flowpad:snippet\nx = 2\n"
    edit_region(path, 0, "snippet", "x = 2\nprint(x)", base="x = 2")
    assert path.read_text() == "# %% flowpad:snippet\nx = 2\nprint(x)\n"


def test_edit_region_refuses_a_file_that_stopped_being_a_snippet(tmp_path):
    path = tmp_path / "s.py"
    path.write_text("print(1)\n")
    with pytest.raises(ValueError):
        edit_region(path, 0, "snippet", "x")
    assert path.read_text() == "print(1)\n"


def test_write_temp_snippet_goes_to_the_os_temp_dir(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    path = write_temp_snippet("print(1)\n", "py", name="t-temp-location")
    try:
        assert path.parent == Path(tempfile.gettempdir()) / "flowpad-snippets"
        assert not any(tmp_path.iterdir())
        assert path.read_text() == "print(1)\n"
    finally:
        path.unlink()


def test_unnamed_temp_snippets_never_share_a_file():
    paths = [write_temp_snippet(f"# %% flowpad:snippet\nprint({i})\n", "py") for i in range(20)]
    try:
        assert len(set(paths)) == 20
        assert [p.read_text().splitlines()[-1] for p in paths] == [f"print({i})" for i in range(20)]
    finally:
        for p in paths:
            p.unlink()


@pytest.mark.parametrize("name", ["../../escaped", "/etc/escaped", "a/b/escaped", "..", " . "])
def test_a_name_cannot_leave_the_snippet_folder(name):
    path = write_temp_snippet("x", "py", name=name)
    try:
        assert path.parent == (Path(tempfile.gettempdir()) / "flowpad-snippets")
    finally:
        path.unlink()


# ── run ─────────────────────────────────────────────────────────────────────


#: The unit tier sandboxes HOME; the plugin keeps the real one here. A login
#: shell under the sandbox reads no dotfiles and rustup finds no toolchain —
#: neither is true of the product, which runs as the user.
_REAL_HOME = os.environ.get("FLOWPAD_PRE_SANDBOX_HOME") or os.path.expanduser("~")


@pytest.fixture(scope="session")
def term_path() -> str:
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("HOME", _REAL_HOME)
        return capture_terminal_path()


@pytest.fixture(autouse=True)
def _real_home_for_toolchains(request, monkeypatch):
    """rustc/cargo read ``~/.rustup`` at run time, so the run needs the real HOME too."""
    if "term_path" in request.fixturenames:
        monkeypatch.setenv("HOME", _REAL_HOME)


@pytest.fixture
def py_path() -> str:
    """python3 is on this process's own PATH; no login shell needed (fast tier)."""
    return os.environ["PATH"]


def _need(tool: str, term_path: str) -> None:
    if tool != "python3" and shutil.which(tool, path=term_path) is None:
        pytest.skip(f"{tool} is not on the terminal PATH")


def _snip(tmp_path: Path, ext: str, body: str, hidden: str = "") -> Path:
    lead = "//" if ext in ("js", "rs") else "#"
    text = f"{lead} %% flowpad:hidden\n{hidden}\n{lead} %% flowpad:snippet\n{body}\n"
    path = tmp_path / f"snippet.{ext}"
    path.write_text(text)
    return path


def _run(path: Path, term_path: str, timeout: float = 5.0):
    return asyncio.run(run_snippet(path, timeout_seconds=timeout, env_path=term_path))


def test_python_ok(tmp_path, py_path):
    r = _run(_snip(tmp_path, "py", "print(json.dumps({'a': 1}))", hidden="import json"), py_path)
    assert (r.returncode, r.stdout, r.timed_out) == (0, '{"a": 1}\n', False)


def test_python_exception_points_at_the_real_line(tmp_path, py_path):
    path = _snip(tmp_path, "py", "x = 1\nraise ValueError('boom')")
    r = _run(path, py_path)
    assert r.returncode == 1
    assert "ValueError: boom" in r.stderr
    assert f'File "{path.resolve()}", line 5' in r.stderr  # the file's own line numbers


def test_python_syntax_error(tmp_path, py_path):
    r = _run(_snip(tmp_path, "py", "def f(:\n  pass"), py_path)
    assert r.returncode == 1 and "SyntaxError" in r.stderr


def test_python_hang_is_killed_at_the_timeout(tmp_path, py_path):
    t0 = time.monotonic()
    r = _run(_snip(tmp_path, "py", "while True:\n    pass"), py_path, timeout=0.3)
    assert r.timed_out and not r.ok
    assert time.monotonic() - t0 < 1.0


def test_output_printed_before_a_hang_survives_the_kill(tmp_path, py_path):
    """The lines before a hang are the ones that say where it hung."""
    r = _run(_snip(tmp_path, "py", "import sys, time\nprint('step 1', flush=True)\nprint('warn', file=sys.stderr, flush=True)\ntime.sleep(60)"), py_path, timeout=0.3)
    assert r.timed_out and r.stdout == "step 1\n" and r.stderr == "warn\n"


def test_unflushed_print_before_a_hang_is_not_lost(tmp_path, py_path):
    """No flush=True: a piped stdout is block-buffered, and the kill drops the buffer."""
    r = _run(_snip(tmp_path, "py", "print('started')\nwhile True:\n    pass"), py_path, timeout=0.3)
    assert r.timed_out and r.stdout == "started\n"


def test_hang_kills_the_whole_process_group(tmp_path, py_path):
    body = "import subprocess, time\np = subprocess.Popen(['sleep', '60'])\nprint(p.pid, flush=True)\ntime.sleep(60)"
    r = _run(_snip(tmp_path, "py", body), py_path, timeout=0.5)
    assert r.timed_out
    pid = int(r.stdout.strip())
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.02)
    pytest.fail(f"grandchild {pid} survived the timeout")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _hang_with_grandchild(tmp_path: Path) -> Path:
    body = "import subprocess, time\np = subprocess.Popen(['sleep', '60'])\nprint('started', p.pid)\ntime.sleep(60)"
    return _snip(tmp_path, "py", body)


def test_stop_kills_the_run_and_keeps_what_it_printed(tmp_path, py_path):
    async def scenario():
        run = asyncio.create_task(run_snippet(_hang_with_grandchild(tmp_path), timeout_seconds=30, env_path=py_path, run_id="r1"))
        await asyncio.sleep(0.4)
        assert stop_snippet("r1") is True
        return await run

    t0 = time.monotonic()
    r = asyncio.run(scenario())
    assert time.monotonic() - t0 < 1.5, "stop must not wait for the 30s timeout"
    assert not r.timed_out and r.detail == "The run was stopped." and not r.ok
    assert r.stdout.startswith("started")
    grandchild = int(r.stdout.split()[1])
    deadline = time.monotonic() + 0.5
    while _alive(grandchild) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not _alive(grandchild), "stop left the snippet's child process running"
    assert stop_snippet("r1") is False, "a finished run is no longer stoppable"


def test_a_dropped_connection_stops_its_runs_and_only_its_runs(tmp_path, py_path):
    """A closed tab runs no unmount cleanup: its socket dropping is what ends its run."""
    hang = _snip(tmp_path, "py", "print('up', flush=True)\nwhile True:\n    pass")

    async def scenario():
        mine = asyncio.create_task(run_snippet(hang, timeout_seconds=30, env_path=py_path, run_id="m", connection_id="tab-1"))
        other = asyncio.create_task(run_snippet(hang, timeout_seconds=30, env_path=py_path, run_id="o", connection_id="tab-2"))
        await asyncio.sleep(0.4)
        assert stop_runs_of("tab-1") == 1
        first = await mine
        assert not other.done(), "another tab's run must keep going"
        stop_snippet("o")
        return first, await other

    t0 = time.monotonic()
    mine, other = asyncio.run(scenario())
    assert time.monotonic() - t0 < 2
    assert mine.detail == "The run was stopped." and mine.stdout == "up\n"
    assert other.detail == "The run was stopped."


def test_stopping_an_unknown_run_is_a_no(tmp_path):
    assert stop_snippet("never-started") is False


def test_a_cancelled_run_does_not_leave_its_process_running(tmp_path, py_path):
    pid_file = tmp_path / "pid"
    body = f"import os, time\nopen({str(pid_file)!r}, 'w').write(str(os.getpid()))\ntime.sleep(60)"

    async def scenario():
        run = asyncio.create_task(run_snippet(_snip(tmp_path, "py", body), timeout_seconds=30, env_path=py_path))
        while not pid_file.exists():
            await asyncio.sleep(0.02)
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run

    asyncio.run(scenario())
    pid = int(pid_file.read_text())
    deadline = time.monotonic() + 0.5
    while _alive(pid) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not _alive(pid), "cancelling the run left the snippet process running"


def test_reading_stdin_fails_instead_of_hanging(tmp_path, py_path):
    r = _run(_snip(tmp_path, "py", "input('? ')"), py_path, timeout=2)
    assert not r.timed_out and r.returncode == 1 and "EOFError" in r.stderr


def test_a_megabyte_of_output_is_capped_and_completes(tmp_path, py_path):
    r = _run(_snip(tmp_path, "py", "import sys\nsys.stdout.write('x' * 1_000_000)\nraise SystemExit(3)"), py_path)
    assert r.returncode == 3 and 0 < len(r.stdout) <= 8192


def test_twenty_concurrent_runs_keep_their_own_output(tmp_path, py_path):
    paths = []
    for i in range(20):
        folder = tmp_path / str(i)
        folder.mkdir()
        paths.append(_snip(folder, "py", f"print({i})"))

    async def all_runs():
        return await asyncio.gather(*(run_snippet(p, timeout_seconds=10, env_path=py_path) for p in paths))

    results = asyncio.run(all_runs())
    assert [r.stdout for r in results] == [f"{i}\n" for i in range(20)]


@pytest.mark.long  # 1.0s one-off terminal PATH capture + 0.6s of node runs
def test_node_ok_throw_syntax_and_hang(tmp_path, term_path):
    _need("node", term_path)
    ok = _run(_snip(tmp_path, "js", "console.log(path.basename('/a/b.txt'))", hidden="const path = require('path');"), term_path)
    assert (ok.returncode, ok.stdout) == (0, "b.txt\n")
    thrown = _run(_snip(tmp_path, "js", "throw new Error('boom')"), term_path)
    assert thrown.returncode == 1 and "Error: boom" in thrown.stderr
    syntax = _run(_snip(tmp_path, "js", "const = 1"), term_path)
    assert syntax.returncode == 1 and "SyntaxError" in syntax.stderr
    hang = _run(_snip(tmp_path, "js", "setInterval(() => {}, 1000)"), term_path, timeout=0.5)
    assert hang.timed_out


@pytest.mark.long  # 4.4s: three ~1s rustc compiles + the 3s hang budget
def test_rust_ok_compile_error_panic_and_hang(tmp_path, term_path):
    _need("rustc", term_path)
    ok = _run(_snip(tmp_path, "rs", 'fn main() {\n    println!("{}", HashMap::<u8, u8>::new().len());\n}', hidden="use std::collections::HashMap;"), term_path, timeout=30)
    assert (ok.returncode, ok.stdout) == (0, "0\n"), ok.stderr
    bad = _run(_snip(tmp_path, "rs", "fn main() { let x: u8 = \"s\"; }"), term_path, timeout=30)
    assert bad.returncode == 1 and "error[E" in bad.stderr
    panic = _run(_snip(tmp_path, "rs", 'fn main() { panic!("boom"); }'), term_path, timeout=30)
    assert panic.returncode == 101 and "boom" in panic.stderr
    hang = _run(_snip(tmp_path, "rs", "fn main() { loop {} }"), term_path, timeout=3)
    assert hang.timed_out


def test_missing_file_unknown_language_and_missing_toolchain(tmp_path, py_path):
    missing = _run(tmp_path / "nope.py", py_path)
    assert missing.returncode is None and "not found" in missing.stderr
    unknown = tmp_path / "a.cobol"
    unknown.write_text("# %% flowpad:snippet\n")
    r = _run(unknown, py_path)
    assert r.returncode is None and "no runner for '.cobol'" in r.stderr
    no_node = asyncio.run(run_snippet(_snip(tmp_path, "js", "console.log(1)"), timeout_seconds=5, env_path="/nonexistent"))
    assert no_node.returncode == 127


def test_every_runner_quotes_the_path(tmp_path, py_path):
    folder = tmp_path / "a dir; with $(spaces)"
    folder.mkdir()
    r = _run(_snip(folder, "py", "print('quoted')"), py_path)
    assert r.stdout == "quoted\n"
    assert set(RUNNERS) >= {".py", ".js", ".rs"}
