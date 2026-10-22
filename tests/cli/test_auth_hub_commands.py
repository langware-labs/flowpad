"""`flow auth` — the four commands the HUB drives, never a human, and ``get-cookie-gate`` for scripts.

These exist so the hub has a channel into a running box that does not require
the box's HTTP server to be up and answering. The loopback
``/auth/login_callback`` curl they replace needs a healthy app to accept
anything, which is precisely what cannot be assumed while a box is starting,
restarting, or (before the supervisor learned the gate) refusing every keyless
caller including its own monitor.

What is under test here is the CLI surface only: the argument each command
takes, what it does with a failure from the layer below, and its exit code. The
behaviour of that layer belongs to tests/unit/test_cookie_gate.py and friends —
duplicating it here would only pin the mock.

The exit code is the whole contract on the hub side: ``_configure_box`` runs
these as three separate steps and raises on any non-zero, because a box that is
signed in but ungated is publicly reachable as that user, and one that is gated
but signed out is useless. Neither is a state to continue from silently.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.flow_cli import app
from flow_sdk.models.bootstrap_models import RuntimeKind

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

runner = CliRunner()


# ── discoverability ───────────────────────────────────────────────────────────


def test_the_hub_driven_commands_are_registered():
    """`_configure_box` invokes these by name over a shell inside the box. A
    rename that only broke the registration would surface as a box that fails to
    configure, at launch, in production."""
    result = runner.invoke(app, ["auth", "--help"])

    assert result.exit_code == 0
    for command in ("set-cookie-gate", "clear-cookie-gate", "hub-login", "set-runtime"):
        assert command in result.output


# ── set-cookie-gate ───────────────────────────────────────────────────────────


def test_set_cookie_gate_arms_with_the_value_it_was_given():
    with patch("flow_sdk.instance_settings.cookie_gate.set_cookie") as arm:
        result = runner.invoke(app, ["auth", "set-cookie-gate", "s3cret-gate"])

    assert result.exit_code == 0
    arm.assert_called_once_with("s3cret-gate")


def test_set_cookie_gate_refuses_an_empty_secret():
    """Arming on "" would store a secret that reads back as unset — an instance
    open while looking locked. The store raises; the command must not swallow
    it into a success."""
    with patch(
        "flow_sdk.instance_settings.cookie_gate.set_cookie",
        side_effect=ValueError("cookie-gate secret must be non-empty"),
    ):
        result = runner.invoke(app, ["auth", "set-cookie-gate", ""])

    assert result.exit_code == 1


def test_set_cookie_gate_requires_a_value():
    """No default. A gate armed with nothing is the failure this whole file is
    about."""
    result = runner.invoke(app, ["auth", "set-cookie-gate"])

    assert result.exit_code != 0


def test_set_cookie_gate_takes_a_dash_leading_secret_after_the_separator():
    """The hub generates the secret with `token_urlsafe`, whose alphabet includes
    `-`, so about one secret in thirty begins with one. Typer reads a leading `-`
    as an option and the command dies on `No such option` -- a box that came up
    with NO gate in front of its public url.

    The hub's fix is to send `--` first. This pins the other half of that
    contract: the CLI must keep treating everything after `--` as the value. It is
    a real risk because the separator is invisible in the signature -- nothing in
    `set_cookie`'s definition mentions it, so a later refactor (custom
    parsing, an eager option, `allow_interspersed_args`) could drop the behaviour
    with nothing here to notice."""
    with patch("flow_sdk.instance_settings.cookie_gate.set_cookie") as arm:
        result = runner.invoke(app, ["auth", "set-cookie-gate", "--", "-9tNyP6uJ6GaI_QoUw8D"])

    assert result.exit_code == 0
    arm.assert_called_once_with("-9tNyP6uJ6GaI_QoUw8D")


# ── clear-cookie-gate ─────────────────────────────────────────────────────────


def test_clear_cookie_gate_disarms():
    with patch("flow_sdk.instance_settings.cookie_gate.clear_cookie_gate", return_value=True) as clear:
        result = runner.invoke(app, ["auth", "clear-cookie-gate"])

    assert result.exit_code == 0
    clear.assert_called_once_with()


def test_clear_cookie_gate_succeeds_on_an_instance_that_was_never_armed():
    """Says so, but exits 0. The caller asked for the instance to be open and it
    is open — failing here would make a retry, or a clear-before-arm, look like a
    broken box."""
    with patch("flow_sdk.instance_settings.cookie_gate.clear_cookie_gate", return_value=False):
        result = runner.invoke(app, ["auth", "clear-cookie-gate"])

    assert result.exit_code == 0
    assert "not armed" in result.output


# ── get-cookie-gate ───────────────────────────────────────────────────────────


def test_get_cookie_gate_prints_the_token_the_backend_checks(local_gate):
    result = runner.invoke(app, ["auth", "get-cookie-gate"])

    assert result.exit_code == 0
    assert result.output.strip() == local_gate.read_text(encoding="utf-8")


# ── hub-login ─────────────────────────────────────────────────────────────────


def test_hub_login_validates_the_key_and_then_finalizes():
    """The REASON this command exists rather than reusing `flow auth login`.

    `login` stores the key and the user and stops. `_finalize_login` also
    broadcasts the OAuth SUCCESS that unblocks a watching UI, folds the
    hub-resolved organization id/role into the user, and invalidates the
    bootstrap cache. A box signed in through the shorter path looks logged in
    locally while reporting something different about itself — so the assertion
    that matters is that BOTH calls happen, in this order.
    """
    validate = AsyncMock(return_value={"id": "user-1", "email": "box@example.com"})
    finalize = AsyncMock(return_value=None)

    with (
        patch("flow_sdk.cli.auth.hub_login.validate_api_key_async", validate),
        patch("flow_sdk.cli.auth.cloud_login._finalize_login", finalize),
    ):
        result = runner.invoke(app, ["auth", "hub-login", "fp_live_abc123"])

    assert result.exit_code == 0
    validate.assert_awaited_once_with("fp_live_abc123")
    finalize.assert_awaited_once()
    # The key it validated is the key it signs in with — not a second read of
    # anything ambient.
    assert finalize.await_args.args[0].token == "fp_live_abc123"
    assert "box@example.com" in result.output


def test_hub_login_reports_a_rejected_key_as_a_failure():
    """`_configure_box` treats a non-zero as fatal for the whole box. A key the
    hub minted being refused means the box is not the one the hub thinks it is."""
    validate = AsyncMock(side_effect=Exception("invalid api key"))
    finalize = AsyncMock(return_value=None)

    with (
        patch("flow_sdk.cli.auth.hub_login.validate_api_key_async", validate),
        patch("flow_sdk.cli.auth.cloud_login._finalize_login", finalize),
    ):
        result = runner.invoke(app, ["auth", "hub-login", "fp_live_bogus"])

    assert result.exit_code == 1
    # A rejected key must not reach _finalize_login: that call broadcasts a
    # login SUCCESS, and announcing one for a key the hub refused is worse than
    # the failure itself.
    finalize.assert_not_awaited()


def test_hub_login_requires_a_key():
    result = runner.invoke(app, ["auth", "hub-login"])

    assert result.exit_code != 0


# ── set-runtime ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("kind", ["sandbox", "agent"])
def test_set_runtime_records_what_the_hub_launched_this_as(kind):
    """The box cannot work this out for itself: a sandbox a human opens and a box
    an agent was deployed into are identical from the inside."""
    with patch(
        "flow_sdk.instance_settings.runtime.set_assigned_runtime",
        return_value=RuntimeKind(kind),
    ) as assign:
        result = runner.invoke(app, ["auth", "set-runtime", kind])

    assert result.exit_code == 0
    assign.assert_called_once_with(kind)
    assert kind in result.output


def test_set_runtime_rejects_a_kind_the_hub_may_not_assign():
    """`desktop`/`browser` are decided per request from the Electron bridge, and
    `hub` is what the hub's own bootstrap returns. An instance can never be told
    it is one of those."""
    with patch(
        "flow_sdk.instance_settings.runtime.set_assigned_runtime",
        side_effect=ValueError("Runtime 'desktop' is not assignable"),
    ):
        result = runner.invoke(app, ["auth", "set-runtime", "desktop"])

    assert result.exit_code == 1


def test_set_runtime_requires_a_kind():
    result = runner.invoke(app, ["auth", "set-runtime"])

    assert result.exit_code != 0


def test_set_runtime_accepts_the_end_of_options_separator():
    """`sandbox`/`agent` never start with a dash, so `--` buys nothing here on its
    own. It is pinned because the hub sends it -- the same `_configure_box` loop
    arms the gate and sets the runtime, and it passes `--` to both rather than
    depend on which values happen to be dash-free. If the CLI ever stopped
    tolerating the separator, launch would break on this command too."""
    with patch(
        "flow_sdk.instance_settings.runtime.set_assigned_runtime",
        return_value=RuntimeKind("sandbox"),
    ) as assign:
        result = runner.invoke(app, ["auth", "set-runtime", "--", "sandbox"])

    assert result.exit_code == 0
    assign.assert_called_once_with("sandbox")


# ── configure-box: the four hub steps in one process ─────────────────────────


def _configure(*extra: str):
    import json

    result = runner.invoke(app, ["auth", "configure-box", "--cookie-gate=-9tNyP6uJ6GaI", "--runtime=sandbox", *extra])
    report = json.loads(result.output.strip().splitlines()[-1])
    return result, report


def test_configure_box_runs_every_step_in_order_and_reports_each():
    calls = []
    with (
        patch("flow_sdk.instance_settings.cookie_gate.set_cookie", side_effect=lambda v: calls.append(("gate", v))),
        patch(
            "flow_sdk.instance_settings.runtime.set_assigned_runtime",
            side_effect=lambda v: calls.append(("runtime", v)),
        ),
        patch(
            "flow_sdk.instance_settings.runtime.set_assigned_compute_node",
            side_effect=lambda v: calls.append(("node", v)),
        ),
    ):
        result, report = _configure("--compute-node=compute_node-1")

    assert result.exit_code == 0
    # The `=` form carries a dash-leading secret intact -- the risk `--` covers for set-cookie-gate.
    assert calls == [("gate", "-9tNyP6uJ6GaI"), ("runtime", "sandbox"), ("node", "compute_node-1")]
    assert report == {"cookie_gate": "ok", "runtime": "ok", "compute_node": "ok", "login_status": None}


def test_configure_box_stops_at_a_gate_it_could_not_arm():
    """Fatal, like the separate step: nothing after an unarmed gate may run -- above all not the login."""
    with (
        patch("flow_sdk.instance_settings.cookie_gate.set_cookie", side_effect=ValueError("empty")),
        patch("flow_sdk.instance_settings.runtime.set_assigned_runtime") as runtime,
    ):
        result, report = _configure("--login-port=1", "--api-key=k")

    assert result.exit_code == 1
    runtime.assert_not_called()
    assert report["cookie_gate"].startswith("error") and report["login_status"] is None


def test_configure_box_stops_at_a_runtime_it_could_not_record():
    with (
        patch("flow_sdk.instance_settings.cookie_gate.set_cookie"),
        patch("flow_sdk.instance_settings.runtime.set_assigned_runtime", side_effect=ValueError("desktop")),
    ):
        result, report = _configure("--login-port=1", "--api-key=k")

    assert result.exit_code == 1
    assert report["runtime"].startswith("error") and report["login_status"] is None


def test_configure_box_a_bad_compute_node_is_reported_not_fatal():
    with (
        patch("flow_sdk.instance_settings.cookie_gate.set_cookie"),
        patch("flow_sdk.instance_settings.runtime.set_assigned_runtime"),
        patch("flow_sdk.instance_settings.runtime.set_assigned_compute_node", side_effect=ValueError("bad id")),
    ):
        result, report = _configure("--compute-node=nope")

    assert result.exit_code == 0
    assert report["compute_node"].startswith("error")


def test_configure_box_signs_in_through_the_apps_route_presenting_the_gate():
    """A real loopback server: the login must reach /auth/login_callback with the key and the
    armed gate, and a 302 (the route's success answer) must be reported, not followed."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import parse_qs, urlparse

    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen["path"] = urlparse(self.path).path
            seen["key"] = parse_qs(urlparse(self.path).query).get("flowpad-api-key")
            seen["gate"] = self.headers.get("X-Cookie-Gate")
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.handle_request, daemon=True).start()
    try:
        with (
            patch("flow_sdk.instance_settings.cookie_gate.set_cookie"),
            patch("flow_sdk.instance_settings.runtime.set_assigned_runtime"),
        ):
            result, report = _configure(f"--login-port={server.server_port}", "--api-key=fp_live_x")
    finally:
        server.server_close()

    assert result.exit_code == 0
    assert report["login_status"] == 302
    assert seen == {"path": "/auth/login_callback", "key": ["fp_live_x"], "gate": "-9tNyP6uJ6GaI"}


def test_configure_box_reports_0_when_nothing_answers_the_login():
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with (
        patch("flow_sdk.instance_settings.cookie_gate.set_cookie"),
        patch("flow_sdk.instance_settings.runtime.set_assigned_runtime"),
    ):
        result, report = _configure(f"--login-port={port}", "--api-key=k", "--login-timeout=2")

    assert result.exit_code == 0
    assert report["login_status"] == 0
