"""The restart tooltip says what changed in words, not two raw JSON dumps."""

from flow_sdk.builtin.agentic_process.agentic_process import _change_summary

LONG = "/Users/me/.local/share/uv/tools/flowpad/lib/python3.11/site-packages/flow_sdk/system_projects/flowpad_assistant"


def test_list_names_added_and_removed_by_last_path_segment():
    assert _change_summary([LONG], [LONG, "/Users/me/dev/proj"]) == "added proj"
    assert _change_summary([LONG], []) == "removed flowpad_assistant"


def test_long_list_is_capped():
    assert _change_summary([], ["a", "b", "c", "d", "e"]) == "added a, b, c +2 more"


def test_dict_keys():
    assert _change_summary({"A": 1, "C": 0}, {"A": 2, "B": 3}) == "added B; removed C; changed A"


def test_scalars():
    assert _change_summary("sonnet", "opus") == "sonnet → opus"
    assert _change_summary(None, "/a/b/c") == "set to c"
    assert _change_summary("x", None) == "cleared (was x)"
