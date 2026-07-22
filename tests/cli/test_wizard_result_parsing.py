"""``flow wizard <id> close <json>`` — parsing results that carry Windows paths.

Wizard agents build the close command by hand and interpolate absolute paths
into it without doubling the separators. On Windows that breaks two ways, and
both were observed in real task-analyze runs:

* ``C:\\Users\\…`` — ``\\U`` is not a valid JSON escape, the parse errors, and
  the agent's entire result is lost.
* ``C:\\temp\\refs`` — ``\\t`` and ``\\r`` ARE valid escapes, so it parses
  *silently* into ``C:<TAB>emp<CR>efs``: no error, just a path pointing
  nowhere. That one is worse precisely because nothing reports it.
"""

import pytest

from flow_sdk.cli.commands.wizard_cmd import _loads_result

WIN_PATH = r"C:\Users\gaditunes\Flowpad workspace\refs\analysis.html"
# Every separator here begins a VALID escape (\t, \r, \n) — this is the payload
# that used to parse "successfully" into garbage.
SILENT_TRAP = r"C:\temp\refs\new.html"


def _close_json(path: str) -> str:
    return r'{"status":"done","data":{"analysisPath":"' + path + '"}}'


@pytest.mark.parametrize(
    "path",
    [
        WIN_PATH,
        SILENT_TRAP,
        r"C:\users\stuff\x",  # lowercase \u — not a valid \uXXXX either
        "C:/Users/x/analysis.html",  # forward slashes: already fine
        "/home/x/analysis.html",  # posix: must stay untouched
    ],
)
def test_path_survives_the_round_trip(path):
    assert _loads_result(_close_json(path))["data"]["analysisPath"] == path


def test_valid_escapes_are_not_clobbered():
    """A payload with no Windows path keeps its real escapes."""
    parsed = _loads_result('{"status":"done","data":{"s":"caf\\u00e9","b":"a\\\\b"}}')
    assert parsed["data"] == {"s": "café", "b": "a\\b"}


def test_full_result_shape_is_preserved():
    raw = (
        r'{"status":"done","data":{"readyForDone":true,"missing":["status"],'
        r'"analysisPath":"' + WIN_PATH + r'","summary":"All three parts verified"}}'
    )
    parsed = _loads_result(raw)
    assert parsed["status"] == "done"
    assert parsed["data"]["readyForDone"] is True
    assert parsed["data"]["missing"] == ["status"]
    assert parsed["data"]["analysisPath"] == WIN_PATH
    assert parsed["data"]["summary"] == "All three parts verified"


@pytest.mark.parametrize("bad", ['{"status": nonsense}', '{"status":"done",', "not json at all"])
def test_malformed_json_still_raises(bad):
    """The repair is a fallback, never a mask — junk stays an error."""
    with pytest.raises(ValueError):
        _loads_result(bad)
