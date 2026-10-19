"""The server log keeps its timestamps.

`logging.info(...)` — the module-level helper, not a logger's method — installs
a root handler in Python's DEFAULT format the first time it is called with no
handler present. In run.py that first call (raising RLIMIT_NOFILE) comes before
app.py's `basicConfig(format="%(asctime)s ...")`, which then silently does
nothing, and every line of the server log loses its timestamp. run.py must log
through a named logger only.

Read from source rather than imported: importing run.py starts the boot
reporter and resets the instance settings, neither of which a unit test wants.
"""

import re
from pathlib import Path

RUN_PY = Path(__file__).resolve().parents[2] / "flow_sdk" / "server" / "run.py"
ROOT_HELPER = re.compile(r"^\s*logging\.(debug|info|warning|error|critical|exception|log)\(", re.MULTILINE)


def test_run_py_never_logs_through_the_root_helpers():
    source = RUN_PY.read_text(encoding="utf-8")
    assert not ROOT_HELPER.findall(source), "run.py must use its named logger, not logging.<level>(...)"
    assert "log = logging.getLogger(__name__)" in source
