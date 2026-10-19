"""The Flow SDK page (``docs/sdk-site``) shows only code a test runs, and it runs in the snippet viewer.

The page drifted once already — cards glued two fences together, showed a driver that did not ship,
and a "runs in CI" label stood over code nothing ran. ``docs/sdk-site/build.py`` now renders every
python card from the docs fence ``cards.json`` names; the fence's own pinned test runs it verbatim
(``test_snippets_are_pinned``). This file is the gate over the page itself.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import re
from pathlib import Path

import pytest

from flow_sdk.snippet_launch import diagnose

REPO = Path(__file__).resolve().parents[2]
SITE = REPO / "docs" / "sdk-site"

_spec = importlib.util.spec_from_file_location("sdk_site_build", SITE / "build.py")
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)

TABLE = build.cards()
PAGE = build.PAGE.read_text()


def _python_cards_on_the_page() -> set[str]:
    ids = set(re.findall(r'<figure class="snip" id="([^"]+)"><pre class="code lang-python"', PAGE))
    ids |= set(re.findall(r'<pre class="code annotated" id="([^"]+)"', PAGE))
    return ids


def test_every_python_card_names_the_fence_it_shows():
    on_page = _python_cards_on_the_page()
    assert on_page, "the card pattern matched nothing — the page's markup moved"
    assert on_page - set(TABLE) == set(), "a python card with no cards.json row shows code nothing runs"
    assert set(TABLE) - on_page == set(), "a cards.json row for a card the page no longer has"


def test_the_page_and_its_markdown_are_what_a_fresh_build_writes():
    stale = [path.name for path, text in build.render().items() if path.read_text() != text]
    assert not stale, f"{stale} out of date with the docs fences — run: uv run python docs/sdk-site/build.py"


def test_no_python_card_is_labelled_illustrative_and_nothing_is_coming():
    """"Illustrative" is for code no test can run (the TypeScript template card); a python card is
    always a fence a test runs. And the page promises nothing that does not ship."""
    for card_id in TABLE:
        start, _ = build._code_span(PAGE, card_id)
        assert 'class="excerpt' not in PAGE[start : PAGE.find("</figure>", start)], f"{card_id} is labelled illustrative"
    for text in (PAGE, build.GUIDE.read_text()):
        assert "coming" not in text.lower(), "the page promises something that does not ship"


def _as_viewer_snippet(source: str) -> str:
    """The card as the snippet viewer holds it: imports hidden, the inputs a reader supplies
    (CAPITAL names — ``NOTES``, ``KEY``) as init, the card itself as the snippet."""
    imports, rest, _ = build.split_imports(source)
    inputs = sorted({d["message"].split("'")[1] for d in diagnose(source, imports=False) if d["kind"] == "name"})
    lowercase = [name for name in inputs if not name.isupper()]
    assert not lowercase, f"the card reads {lowercase} and defines none of them — not a program a reader can run"
    init = "".join(f"{name} = {name!r}\n" for name in inputs)
    return f"# %% flowpad:hidden\n{imports}# %% flowpad:init\n{init}# %% flowpad:snippet\n{rest}\n"


@pytest.mark.parametrize("card_id", sorted(TABLE))
def test_each_card_passes_the_snippet_viewers_check(card_id):
    """What the viewer marks: syntax, a name nothing binds, an import this interpreter cannot satisfy."""
    text = _as_viewer_snippet(build.program(TABLE[card_id]))
    assert diagnose(text, f"{card_id}.py") == []


#: Cards that need nothing but this interpreter and a folder: the viewer's Run proves them outright.
OFFLINE = ["c2-shapes-0", "c2-shapes-1", "c2-shapes-2", "c2-shapes-3", "op-dataspec"]


@pytest.mark.long  # ~0.4s per card: one real `python -m flow_sdk.snippet_launch` each
@pytest.mark.parametrize("card_id", OFFLINE)
def test_an_offline_card_runs_in_the_snippet_viewer_as_shown(card_id, tmp_path):
    from flow_sdk.core.snippet import run_snippet

    path = tmp_path / f"{card_id}.py"
    path.write_text(_as_viewer_snippet(build.program(TABLE[card_id])))
    result = asyncio.run(run_snippet(path, timeout_seconds=30, env_path=os.environ["PATH"]))
    assert result.returncode == 0, result.stderr
