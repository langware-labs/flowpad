"""``docs/snippets/llm-endpoints.md`` §7's script, run exactly as a reader runs it: ``python <file>``.

The script names no hub, no key and no budget — the box funds the turn with whatever it resolves. Here
that is this machine's own LLM source (a signed-in vendor CLI works), in a throwaway Flow instance so
nothing of the real one is read or written. The loginless claim — a box that never logged in, funded by
a PUBLIC hub endpoint — is ``test_loginless_in_docker.py``'s, over the same file.
"""

import os
import pwd
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tests.utils.snippets import doc, fences

pytestmark = [pytest.mark.timeout(300)]  # one real model turn in print mode


def test_the_script_answers_as_written(tmp_path):
    if shutil.which("claude") is None:
        pytest.skip("needs a claude CLI this machine is signed in to")
    from cryptography.fernet import Fernet

    script = tmp_path / "run" / "agentic_process_snippet.py"
    script.parent.mkdir()
    script.write_text(fences(doc("llm-endpoints.md"))[-1])
    # The suite sandboxes HOME; the vendor CLI's own login lives in the account's real one.
    real_home = pwd.getpwuid(os.getuid()).pw_dir
    env = {**os.environ, "HOME": real_home, "FLOW_HOME": str(tmp_path), "FLOW_INSTANCE": "llm-script",
           "FLOWPAD_SKIP_DOTENV": "true", "SOD_ENC_KEY": Fernet.generate_key().decode()}
    done = subprocess.run([sys.executable, script.name], cwd=script.parent, env=env, capture_output=True, text=True,
                          timeout=280, check=False)
    assert done.returncode == 0, done.stderr[-2000:]
    assert done.stdout.strip().splitlines()[-1].strip().lower() == "pong", done.stdout[-1000:]
    assert Path(script).read_text().strip("\n") == (Path(__file__).parents[1] / "loginless_e2e" / "agentic_process_snippet.py").read_text().strip("\n")
