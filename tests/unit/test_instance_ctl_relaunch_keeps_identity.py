"""A relaunch keeps the instance's hub and user.

``launch <name>`` with no ``--hub``/``--email`` is how the api tier's restart tests bring a
backend back (``pty_survives_restart.test.ts``). It used to rewrite ``.env.<name>.local`` with the
default hub and the default user, so the instance moved to a hub that is not there and every hub
test after it failed ("Can't reach the hub"). What a flag does not say is what the env file holds.
"""

from __future__ import annotations

import re
import subprocess

from flow_sdk.instances import paths

SHIM = paths.REPO_ROOT / "scripts" / "instance_ctl.sh"


def _resolve(repo_root, *flags: str, env: dict | None = None) -> dict:
    """Run the launcher's own flag handling for ``launch qa-1`` and print what it settled on."""
    text = SHIM.read_text()
    head = re.search(r"^HUB_URL_DEFAULT=.*?\n", text, re.M).group(0)
    env_file = re.search(r"^env_file\(\).*?\n", text, re.M).group(0)
    keep = re.search(r"^keep_identity_of\(\) \{.*?^\}\n", text, re.S | re.M)
    keep = keep.group(0) if keep else "keep_identity_of() { :; }\n"  # a launcher that keeps nothing
    parse = re.search(r'^  local email="" password="" hub=.*?^  email="\$\{email:-\$name@local.test\}"\n', text, re.S | re.M).group(0)
    script = (
        f"REPO_ROOT={repo_root}\n{head}{env_file}{keep}"
        "die() { echo \"$*\" >&2; exit 1; }\n"
        "resolve() {\n  local name=\"$1\"; shift\n"
        f"{parse}"
        '  echo "hub=$hub"; echo "email=$email"\n}\n'
        f"resolve qa-1 {' '.join(flags)}\n"
    )
    run = subprocess.run(["bash", "-c", script], env={"PATH": "/usr/bin:/bin", **(env or {})},
                         capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr
    return dict(line.split("=", 1) for line in run.stdout.splitlines())


def _env_file(tmp_path, hub="http://localhost:8193", email="alice@local.test"):
    (tmp_path / ".env.qa-1.local").write_text(
        f"FLOW_INSTANCE=qa-1\nFLOWPAD_HUB_URL={hub}\nFLOWPAD_CLOUD_USER_EMAIL={email}\nFLOWPAD_CLOUD_USER_PASSWORD=pw\n"
    )


def test_a_bare_relaunch_keeps_the_hub_and_the_user_it_was_launched_with(tmp_path):
    _env_file(tmp_path)
    assert _resolve(tmp_path) == {"hub": "http://localhost:8193", "email": "alice@local.test"}


def test_flags_still_win(tmp_path):
    _env_file(tmp_path)
    assert _resolve(tmp_path, "--hub", "http://localhost:9999", "--email", "bob@local.test") == {
        "hub": "http://localhost:9999", "email": "bob@local.test",
    }


def test_the_shell_hub_variable_does_not_move_a_relaunched_instance(tmp_path):
    _env_file(tmp_path)
    assert _resolve(tmp_path, env={"FLOWPAD_HUB_URL": "http://localhost:7777"})["hub"] == "http://localhost:8193"


def test_a_first_launch_takes_the_defaults(tmp_path):
    assert _resolve(tmp_path) == {"hub": "http://localhost:8093", "email": "qa-1@local.test"}
    assert _resolve(tmp_path, env={"FLOWPAD_HUB_URL": "http://localhost:7777"})["hub"] == "http://localhost:7777"
