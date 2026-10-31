"""The one table of chart formats: every format the editor knows gets its source file on scaffold."""
import json

import pytest

from flow_sdk.assets.types.chart import CHART_FORMATS, CHART_MD, CHART_SOURCES, chart_format, declared_chart_format
from flow_sdk.assets.types.chart_spec import ChartSpec
from flow_sdk.assets.types.scaffolds import scaffold_chart


def test_every_format_but_mermaid_has_a_source_file():
    # mermaid keeps its source inside CHART.md; every other format names its own file.
    assert set(CHART_SOURCES) == set(CHART_FORMATS) - {"mermaid"}


@pytest.mark.parametrize("fmt", [f for f in CHART_FORMATS if f != "mermaid"])
def test_scaffold_writes_the_formats_empty_source(tmp_path, fmt):
    folder = tmp_path / "chart"
    folder.mkdir()
    scaffold_chart(folder, ChartSpec(name="arch", format=fmt), None)

    source, empty = CHART_SOURCES[fmt]
    assert (folder / CHART_MD).is_file()
    assert json.loads((folder / source).read_text()) == json.loads(empty)


def test_scaffold_never_overwrites_an_authored_source(tmp_path):
    folder = tmp_path / "chart"
    folder.mkdir()
    (folder / "c4.json").write_text('{"level": "container", "elements": [{"id": "a"}]}')
    scaffold_chart(folder, ChartSpec(name="arch", format="c4"), None)
    assert json.loads((folder / "c4.json").read_text())["elements"] == [{"id": "a"}]


def test_c4_is_a_known_format():
    assert chart_format({"format": "c4"}) == "c4"


def test_an_unknown_format_is_kept_as_declared_for_the_editor_to_name():
    assert declared_chart_format({"format": "hologram"}) == "hologram"
    assert declared_chart_format({}) == "excalidraw"
    assert chart_format({"format": "hologram"}) == "excalidraw"  # what THIS build can draw
