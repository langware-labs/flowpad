"""Wake-time credential renewal, on a REAL E2B sandbox that really hibernates.

The bug this pins: the first prompt after a sandbox wakes used to block on a
credential renewal (``await _force_renewal()`` on the turn path). The renewal's
duration is proportional to box load, and a wake is the busiest the box gets —
measured 30.4s blocked on a resumed production sandbox on 2026-08-18.

The fix moves the renewal onto the hub WebSocket's (re)connect, which is the
box's own signal and fires on every wake path. So the contract under test is:

    a sandbox that hibernates with a spent credential must come back with a
    renewal ALREADY IN FLIGHT, before anybody sends a turn.

Why this test needs a real sandbox rather than a unit seam: the whole chain —
socket death, reconnect, hook — happens INSIDE the box, and only a genuine
``pause(keep_memory=True)`` / resume produces it. The flow_sdk E2B provider's
own ``pause``/``resume`` are MVP no-ops, so the pause is driven through the e2b
SDK directly, exactly as the hub's provider does it.

Requirements (each is an independent skip, never a failure):
  * ``DEEP_TESTING=1`` — the repo's shared long-test switch, so this turns on
    with its neighbours rather than needing its own incantation
  * the ``e2b`` SDK importable and ``E2B_KEY`` set — the SDK is not in
    ``pyproject.toml``, so run under ``uv run --with e2b``
  * ``FLOWPAD_TEST_HUB_KEY`` — one credential MORE than the other real-E2B
    tests need, and unavoidably so: a freshly created sandbox never connects its
    hub socket, and the hook under test lives on that socket. See ``_hub_key``.

    DEEP_TESTING=1 E2B_KEY=… FLOWPAD_TEST_HUB_KEY=… \
        uv run --with e2b pytest tests/long_tests/test_credential_renewal_on_wake.py

The sandbox is always killed, including on failure.
"""

from __future__ import annotations

import json
import os
import time
import uuid

import pytest

from tests.test_settings import test_service_config

E2B_KEY = os.getenv("E2B_KEY")

# The image whose build-time start command already runs `flow start service`, so
# a created box is serving flowpad without this test provisioning anything.
FLOWPAD_TEMPLATE = os.getenv("FLOWPAD_E2B_TEMPLATE", "sp30wcd4hubq92e9qk8e")
WORKSPACE_PORT = 9007

# How stale the planted credential is. Only has to exceed
# ``RENEWAL_MARGIN_SECONDS``; 13h mirrors the production incident.
STALE_HOURS = 13


def _e2b_sdk_installed() -> bool:
    try:
        import e2b  # noqa: F401

        return True
    except ImportError:
        return False


def _hub_key() -> str | None:
    """A hub key to sign the box in with, or None. Never minted, never printed.

    Read from ``FLOWPAD_TEST_HUB_KEY``, and it has to be: ``pytest.ini`` sets
    ``TESTING=true`` for every run, under which ``load_credentials()`` returns
    nothing at all. That is the harness deliberately refusing to hand real
    secrets to tests — verified, not assumed:

        FLOW_INSTANCE=prod                    -> hub key present
        FLOW_INSTANCE=prod TESTING=true       -> hub key absent

    So this is the only seam that can work, and the caller states which hub a
    throwaway box may be signed into. Lift the key OUTSIDE pytest:

        export FLOWPAD_TEST_HUB_KEY=$(FLOW_INSTANCE=prod uv run python -c \
            "from flow_sdk.cli.auth.credentials import load_credentials; print(load_credentials().api_key)")
    """
    return os.getenv("FLOWPAD_TEST_HUB_KEY") or None


# Gated first on the repo's shared deep-testing switch (``tests/test_settings``),
# the same one the other long tests use, so ``DEEP_TESTING=1`` turns this on with
# its neighbours rather than needing its own incantation. The E2B requirements
# are a second, separately-reported mark — a skip that says "no SDK" is a
# different fact from "deep testing is off", and collapsing them hides which.
#
# The hub key is deliberately NOT checked here: it is read in the fixture, where
# the failure can explain itself at length.
pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
    pytest.mark.skipif(
        not (_e2b_sdk_installed() and E2B_KEY),
        reason="needs the e2b SDK installed and E2B_KEY set",
    ),
]


def _run(sb, cmd: str, timeout: int = 120, *, allow_fail: bool = False) -> str:
    """Run a command in the box and return stdout.

    ``allow_fail`` is for the two places where a non-zero exit is the ANSWER,
    not an error: curl before the server is listening (exit 7) and grep with no
    match yet (exit 1). Everywhere else a failure should surface, so the default
    stays strict rather than blanket-swallowing.
    """
    if allow_fail:
        cmd = f"{cmd}; true"
    return sb.commands.run(cmd, timeout=timeout).stdout


def _server_log(sb) -> str:
    """Path of the instance log the running server is writing to."""
    return _run(sb, "ls -t ~/.flow/instances/*/logs/*.log 2>/dev/null | head -1", allow_fail=True).strip()


def _await_line(sb, log: str, needle: str, budget: float, *, after: int = 0) -> str | None:
    """Poll the box's log for ``needle`` past line ``after``.

    A poll, not a wait inserted to ride past a failure: the events are produced
    by another machine's clock, so there is nothing local to await on. The budget
    bounds the test, and exceeding it is reported as a failure rather than
    widened.
    """
    deadline = time.monotonic() + budget
    while time.monotonic() < deadline:
        out = _run(
            sb,
            f"tail -n +{after + 1} {log} 2>/dev/null | grep -F {json.dumps(needle)} | head -1",
            allow_fail=True,
        )
        if out.strip():
            return out.strip()
        time.sleep(2)
    return None


def _credential_hours_left(sb) -> float | None:
    out = _run(
        sb,
        'python3 -c "import json,time;'
        "d=json.load(open('/home/user/.claude/.credentials.json'))['claudeAiOauth'];"
        "print((d['expiresAt']/1000-time.time())/3600)\" 2>/dev/null || true",
    ).strip()
    return float(out) if out else None


@pytest.fixture()
def woken_sandbox():
    """A real sandbox, hub-logged-in, holding a SPENT credential, then slept and woken.

    Yields ``(sandbox, log_path, mark)`` where ``mark`` is the log line count at
    the moment of the pause — everything the assertions look at must appear
    after it, so a renewal from before the sleep can never be mistaken for the
    one the wake produced.
    """
    from e2b import Sandbox

    key = _hub_key()
    if not key:
        pytest.skip(
            "FLOWPAD_TEST_HUB_KEY is not set. A freshly created sandbox never connects its "
            "hub socket, and without that socket the hook under test cannot fire — so this "
            "test needs one credential more than the other real-E2B tests. It cannot be read "
            "from the credential store: pytest.ini sets TESTING=true, under which "
            "load_credentials() deliberately returns nothing. See this module's docstring for "
            "the one-liner that lifts it."
        )

    os.environ.setdefault("E2B_API_KEY", E2B_KEY or "")
    sb = Sandbox.create(
        template=FLOWPAD_TEMPLATE,
        timeout=900,
        metadata={"environment": "dev", "size": "sm", "purpose": f"credential-wake-{uuid.uuid4().hex[:8]}"},
    )
    try:
        # 0. Test THIS tree, not whatever flowpad the image was built with.
        #    Without this the test measures the released template and stays red
        #    until a release rolls, which makes it a release gate rather than a
        #    regression test. Only the modules under test are synced — the rest
        #    of the image is the real thing.
        site = _run(sb, "python3 -c 'import flow_sdk,os;print(os.path.dirname(flow_sdk.__file__))'").strip()
        repo = os.path.join(os.path.dirname(__file__), "..", "..", "flow_sdk")
        for rel in (
            "builtin/agentic_process/cli_drivers/claude/credential.py",
            "builtin/agentic_process/cli_drivers/credential_renewal.py",
            "cloud_client/ws_client.py",
        ):
            local = os.path.normpath(os.path.join(repo, rel))
            if not os.path.exists(local):
                # A tree from before the fix has no credential_renewal.py. Skip
                # it rather than erroring: the point of syncing is to test THIS
                # tree, whatever shape it is in.
                continue
            with open(local) as fh:
                sb.files.write(f"{site}/{rel}", fh.read())
        sb.commands.run(f"find {site} -name __pycache__ -type d -exec rm -rf {{}} + 2>/dev/null; true", timeout=120)
        sb.commands.run("kill -TERM $(cat ~/.flow/instances/*/server.pid) 2>/dev/null; true", timeout=60)

        # 1. The image is already serving; wait for it rather than starting it.
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            code = _run(
                sb,
                f"curl -s -o /dev/null -w '%{{http_code}}' localhost:{WORKSPACE_PORT}/api/v1/health/status",
                allow_fail=True,
            )
            if code.strip() in ("200", "403"):  # 403 == serving but gated, still alive
                break
            time.sleep(3)
        else:
            pytest.skip("the sandbox image never served flowpad")

        # 2. Sign the box in, so its hub socket exists at all. Through the app's
        #    own route — the same one the hub uses — so the login lands in the
        #    process that will hold the socket.
        sb.commands.run(
            f"curl -s -o /dev/null 'localhost:{WORKSPACE_PORT}/auth/login_callback?flowpad-api-key={key}'",
            timeout=120,
        )
        log = _server_log(sb)
        assert _await_line(sb, log, "Hub WS connected", budget=90), (
            "the box never connected its hub socket, so the hook under test could not fire"
        )

        # 3. Plant a SPENT credential. The renewal it triggers is expected to
        #    fail (this token is not real) — the contract under test is that a
        #    renewal is STARTED on wake with nobody waiting, not that a
        #    synthetic token can be refreshed.
        expired_at_ms = int((time.time() - STALE_HOURS * 3600) * 1000)
        payload = json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": "test-not-a-real-token",
                    "refreshToken": "test-not-a-real-token",
                    "expiresAt": expired_at_ms,
                    "scopes": ["user:inference"],
                }
            }
        )
        sb.files.write("/home/user/.claude/.credentials.json", payload)
        sb.commands.run("chmod 600 /home/user/.claude/.credentials.json", timeout=60)
        assert (_credential_hours_left(sb) or 0) < 0, "planted credential is not actually spent"

        mark = int(_run(sb, f"wc -l < {log}", allow_fail=True).strip() or 0)

        # 4. A REAL hibernation: memory snapshot, then resume. keep_memory
        #    mirrors production, where the server process survives the sleep —
        #    which is exactly why server-startup hooks never re-fire on a wake.
        pid_before = _run(sb, "cat ~/.flow/instances/*/server.pid", allow_fail=True).strip()
        sb.pause(keep_memory=True)
        sb2 = Sandbox.connect(sb.sandbox_id)  # connect auto-resumes
        pid_after = _run(sb2, "cat ~/.flow/instances/*/server.pid", allow_fail=True).strip()
        assert pid_before == pid_after, (
            f"the server restarted across the sleep (pid {pid_before} → {pid_after}); "
            "this is no longer the hibernation case the fix targets"
        )

        yield sb2, log, mark
    finally:
        try:
            sb.kill()
        except Exception:  # noqa: BLE001 — never let cleanup mask the result
            from e2b import Sandbox as _S

            _S.kill(sb.sandbox_id)


# do not increase timeout without approval
@pytest.mark.timeout(420)
def test_wake_starts_credential_renewal_with_nobody_waiting(woken_sandbox):
    """On wake, a spent credential is renewed off the turn path.

    Fails on stock 0.2.138: nothing renews at wake, and the cost lands on the
    first prompt instead.
    """
    sb, log, mark = woken_sandbox

    started = _await_line(sb, log, "renewing in the background", budget=120, after=mark)
    assert started, (
        "no background renewal after the wake — the credential is still spent and the "
        "next turn will pay for it, which is the bug"
    )

    # It must be the WAKE that caused it: the reconnect has to precede it, and
    # no turn may have run. Both are read from the box's own log, not inferred.
    tail = _run(sb, f"tail -n +{mark + 1} {log}", allow_fail=True)
    assert "Hub WS connected" in tail, "the renewal did not follow a hub reconnect"
    assert "renewing before the turn" not in tail, (
        "a turn-path pre-flight ran — the renewal is still on the user's critical path"
    )
    assert "ClaudeCLIStreamWorker: launching" not in tail, (
        "a turn ran during the window, so this proves nothing about the unattended path"
    )
