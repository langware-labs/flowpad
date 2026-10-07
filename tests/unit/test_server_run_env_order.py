"""The backend's ``.env.<instance>.local`` decides which hub it talks to.

``flow_sdk.config.default_service_config`` reads the environment ONCE, when the module is first
imported. ``flow_sdk/server/run.py`` loads the instance's dotenv file at module level, so anything it
imports ABOVE that load which reaches ``flow_sdk.config`` freezes the config before the file is read.
That happened: an ``env_probe`` import moved above the load, and a dev backend whose
``.env.dev.local`` said staging silently talked to app.flowpad.ai.

The backend is imported in a fresh interpreter, exactly as ``python -m flow_sdk.server.run`` would
load it (the server itself only starts under ``__main__``), with the hub named ONLY in the env file.
"""

import subprocess
import sys

PROBE = (
    "import flow_sdk.server.run\n"
    "from flow_sdk.config import default_service_config\n"
    "print(default_service_config.flowpad_hub_url)\n"
)


def test_the_hub_named_in_the_instance_env_file_is_the_hub_the_backend_uses(tmp_path):
    env_file = tmp_path / "instance.env"
    env_file.write_text("FLOWPAD_HUB_URL=https://hub.example.test\nFLOW_INSTANCE=env-order-test\n")
    env = {"HOME": str(tmp_path), "PATH": "/usr/bin:/bin", "FLOW_HOME": str(tmp_path / "flow"), "ENV": str(env_file)}

    out = subprocess.run([sys.executable, "-c", PROBE], env=env, capture_output=True, text=True, timeout=60)

    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.strip().splitlines()[-1] == "https://hub.example.test", (
        "the backend froze its hub before loading the instance's .env file"
    )
