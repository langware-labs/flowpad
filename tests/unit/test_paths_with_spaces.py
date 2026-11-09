"""A box's workspace is "/home/user/Flowpad workspace": every path the code hands to a shell or to an agent as a
command must survive the space."""

import shlex

from flow_sdk.builtin.agent_auto_open import AutoOpenTab, auto_open_commands
from flow_sdk.core.webapp.failure import normalize
from flow_sdk.flowpad_types.machine_status import python_command

BOX_FILE = "/home/user/Flowpad workspace/ai-course-lesson-3/games/snake/index.html"


def test_auto_open_command_keeps_a_spaced_path_one_argument():
    [cmd] = auto_open_commands([AutoOpenTab(pointer="{}", path=BOX_FILE)])
    assert shlex.split(cmd) == ["flow", "show", "file", BOX_FILE]


def test_machine_status_command_keeps_a_spaced_script_path_one_argument():
    script = "/tmp/a b/_machine_status.py"
    assert shlex.split(python_command(script, "Linux")) == ["python3", script]


def test_failure_fingerprint_drops_the_whole_spaced_log_path():
    text = "start failed — log: /home/user/Flowpad workspace/x/.flow/run.log"
    assert "workspace" not in normalize(text)
