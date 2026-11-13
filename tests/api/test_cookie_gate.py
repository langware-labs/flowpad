"""cookie-gate over the real ASGI stack.

Two halves matter: unarmed it must be provably inert, and armed it must answer
nothing without the secret — including the routes that would be the obvious
things to exempt.

Patching notes:
  - The middleware binds ``get_cookie_gate`` at module load, so gate state is
    forced by patching the name AS USED in cookie_gate_middleware.
  - ``/auth/gate`` and ``login_callback`` import their cookie_gate names inside
    the handler, so those resolve at call time and are patched at their source.
"""

from __future__ import annotations

import contextlib
import os
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.server import grants
from tests.utils.gate import ENDPOINT, SECRET
from tests.utils.gate import armed as _stored
from tests.utils.gate import cookie_value as _cookie_value
from tests.utils.gate import grant_cookie as _grant
from tests.utils.gate import ticket as _ticket

COOKIE = grants.COOKIE_NAME
TEST_API_KEY = "fp_production_testkey123456789abc"
USER_INFO = {"id": "user_abc123", "name": "Test User", "email": "test@example.com"}

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _armed(secret: str | None = SECRET):
    """Force the gate's view of the stored secret; with one, also lift the suite's off switch."""
    stack = contextlib.ExitStack()
    stack.enter_context(_stored(secret))
    if secret is not None:
        stack.enter_context(patch.dict(os.environ, {"FLOWPAD_COOKIE_GATE": "on"}))
    return stack


def _login_mocks():
    """The mock set login_callback needs, per test_cloud_login_flow.py:215-224."""
    return (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(return_value=USER_INFO),
        ),
        patch("flow_sdk.cli.auth.cloud_login.save_credentials"),
        patch("flow_sdk.cli.auth.cloud_login.set_user"),
        patch("flow_sdk.server.routes.auth.is_secrets_enabled", return_value=True),
    )


# ---------------------------------------------------------------------------
# Unarmed — the default, and every desktop install
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/api/v1/cloud/status", "/health/status", "/health/version"])
@pytest.mark.asyncio
async def test_unarmed_is_untouched(client, path):
    with _armed(None):
        response = await client.get(path)

    assert response.status_code == 200
    assert "set-cookie" not in response.headers


@pytest.mark.asyncio
async def test_unarmed_gate_route_redirects_without_a_cookie(client):
    """A stale gate link on an ungated instance lands in the app rather than
    404ing or minting a meaningless cookie."""
    with _armed(None), _stored(None):
        response = await client.get(f"/auth/gate?ticket={_ticket()}&next=/")

    assert response.status_code == 302
    assert response.headers["location"] == "/"
    assert "set-cookie" not in response.headers


@pytest.mark.asyncio
async def test_gate_on_this_machine_sets_the_local_cookie_and_goes_on_to_the_login(client):
    """The backend opens the hub login through /auth/gate, so the browser holds the
    local cookie when the hub sends it back to this host."""
    login = "https://app.flowpad.ai/api/v1/login?target_path=x"
    with _armed(), _stored():
        response = await client.get(
            "/auth/gate", params={"cookie-gate": SECRET, "next": login}, headers={"host": "127.0.0.1:9007"}
        )

    assert response.status_code == 302
    assert response.headers["location"] == login
    assert response.headers["set-cookie"].startswith(f"cookie-gate-9007={SECRET};")


DIRECT_OPEN = {"sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document"}


@pytest.mark.parametrize(
    "arrival",
    [
        pytest.param({"cookie": f"cookie-gate-9007={SECRET}"}, id="web-page-click-with-the-lax-cookie"),
        pytest.param(DIRECT_OPEN, id="desktop-app-click-direct-open"),
    ],
)
@pytest.mark.asyncio
async def test_gate_without_the_token_in_the_url_stays_on_this_instance(client, arrival):
    """A crafted link reaches /auth/gate without its sender holding the token. Its absolute
    `next` must not be followed, or every Flowpad would redirect anywhere on request."""
    with _armed(), _stored():
        response = await client.get(
            "/auth/gate", params={"next": "https://evil.example/"}, headers={"host": "127.0.0.1:9007", **arrival}
        )

    assert response.status_code == 302
    assert response.headers["location"] == "/"


# ---------------------------------------------------------------------------
# Arming, via the hub's loopback callback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_callback_with_secret_arms_the_instance(client):
    v, save, set_user, secrets_on = _login_mocks()
    with v, save, set_user, secrets_on, _armed(None):
        with patch("flow_sdk.instance_settings.cookie_gate.set_cookie") as arm:
            response = await client.get(f"/auth/login_callback?flowpad-api-key={TEST_API_KEY}&cookie-gate={SECRET}")

    assert response.status_code == 200
    arm.assert_called_once_with(SECRET)


@pytest.mark.asyncio
async def test_callback_without_secret_does_not_arm(client):
    v, save, set_user, secrets_on = _login_mocks()
    with v, save, set_user, secrets_on, _armed(None):
        with patch("flow_sdk.instance_settings.cookie_gate.set_cookie") as arm:
            response = await client.get(f"/auth/login_callback?flowpad-api-key={TEST_API_KEY}")

    assert response.status_code == 200
    arm.assert_not_called()


@pytest.mark.asyncio
async def test_invalid_key_does_not_arm(client):
    """Arming on an unvalidated request would let an anonymous caller lock the
    instance with a secret only they hold."""
    with (
        patch(
            "flow_sdk.cli.auth.hub_login.validate_api_key_async",
            new=AsyncMock(side_effect=ValueError("bad key")),
        ),
        patch("flow_sdk.server.routes.auth.is_secrets_enabled", return_value=True),
        _armed(None),
        patch("flow_sdk.instance_settings.cookie_gate.set_cookie") as arm,
    ):
        response = await client.get(f"/auth/login_callback?flowpad-api-key=bogus&cookie-gate={SECRET}")

    assert response.status_code == 400
    arm.assert_not_called()


@pytest.mark.asyncio
async def test_callback_still_runs_once_armed(client):
    """A re-login is the hub's loopback curl, which presents the secret as the machine
    HEADER and so passes its own gate. This is why the callback needs no exemption; the
    ``cookie-gate`` query parameter is the route's own arming value, not a credential.

    Regression: the middleware must not answer this request itself. curl reports
    a 302 as success (compute_node.py:495), so bouncing it here would have the
    hub declare a login that never ran — which is why the exchange is a separate
    route rather than a branch keyed off request headers.
    """
    v, save, set_user, secrets_on = _login_mocks()
    with v, save, set_user, secrets_on, _armed(SECRET):
        with patch("flow_sdk.instance_settings.cookie_gate.set_cookie") as arm:
            response = await client.get(
                f"/auth/login_callback?flowpad-api-key={TEST_API_KEY}&cookie-gate={SECRET}",
                headers={"X-Cookie-Gate": SECRET},
            )

    assert response.status_code == 200
    assert "Login Successful" in response.text
    arm.assert_called_once_with(SECRET)


# ---------------------------------------------------------------------------
# Armed — refusal
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/cloud/status",
        # No path is exempt. The hub probes health before it arms the gate, so
        # this costs nothing at launch.
        "/health/status",
        # Not even the exchange route — it is reachable because the caller
        # presents the secret, not because it is on a list.
        "/auth/gate?next=/",
    ],
)
@pytest.mark.asyncio
async def test_armed_without_secret_is_forbidden(client, path):
    with _armed():
        response = await client.get(path)

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_forbidden_is_a_self_contained_page(client):
    """The audience is a human who clicked a stale link, not a script parsing an
    envelope. Static is gated too, so it can reference no assets."""
    with _armed():
        response = await client.get("/api/v1/cloud/status")

    assert response.headers["content-type"].startswith("text/html")
    assert "Forbidden" in response.text
    assert "FAIL" not in response.text
    assert "<link" not in response.text
    assert "<script" not in response.text
    assert "src=" not in response.text
    assert SECRET not in response.text


@pytest.mark.parametrize(
    ("request_kwargs", "cookie_line", "ticket_line"),
    [
        ({}, "none", "none"),
        ({"cookies": {COOKIE: "v1.x.1.y"}}, "bad-signature (from before a restart, or another box)", "none"),
        ({"params": {"ticket": "junk"}}, "none", "malformed"),
    ],
    ids=["nothing", "foreign-cookie", "junk-ticket"],
)
@pytest.mark.asyncio
async def test_forbidden_page_says_why(client, request_kwargs, cookie_line, ticket_line):
    """One screenshot names the cause: which credential was missing or wrong, and how the browser asked."""
    headers = {
        "sec-fetch-dest": "document",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2_0 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) CriOS/157.0.8103.37 Mobile/15E148 Safari/604.1",
    }
    with _armed():
        response = await client.get("/dock/vibe/x", headers=headers, **request_kwargs)

    assert response.status_code == 403
    page = response.text
    assert f"<dt>cookie</dt><dd>{cookie_line}</dd>" in page
    assert f"<dt>ticket</dt><dd>{ticket_line}</dd>" in page
    assert "<dd>document / cross-site / navigate</dd>" in page
    assert "<dd>Chrome iOS 157 / iOS 27.2</dd>" in page
    assert "<dd>/dock/vibe/x</dd>" in page
    assert f"cookie={cookie_line}" in response.headers["x-flowpad-gate"]
    assert response.headers["cache-control"] == "no-store"
    assert SECRET not in page and "<script" not in page


@pytest.mark.asyncio
async def test_forbidden_page_never_echoes_a_credential_or_markup(client):
    sent = "v1.visitor|app|abc.1.deadbeef"
    with _armed():
        response = await client.get(
            "/<script>alert(1)</script>", params={"ticket": "v1.secretish.1.cafe"}, cookies={COOKIE: sent}
        )

    assert response.status_code == 403
    assert "<script>alert(1)" not in response.text
    assert "&lt;script&gt;" in response.text
    assert "deadbeef" not in response.text and "cafe" not in response.text


@pytest.mark.parametrize(
    "request_kwargs",
    [
        {"cookies": {COOKIE: "wrong"}},
        {"headers": {"X-Cookie-Gate": "wrong"}},
        {"params": {"ticket": "wrong"}},
    ],
    ids=["cookie", "header", "ticket"],
)
@pytest.mark.asyncio
async def test_wrong_credential_is_forbidden(client, request_kwargs):
    with _armed(), _stored():
        response = await client.get("/health/status", **request_kwargs)

    assert response.status_code == 403


@pytest.mark.parametrize(
    "request_kwargs",
    [
        {"cookies": {COOKIE: SECRET}},
        {"params": {"cookie-gate": SECRET}},
        {"params": {"ticket": SECRET}},
    ],
    ids=["secret-as-cookie", "secret-as-query", "secret-as-ticket"],
)
@pytest.mark.asyncio
async def test_the_secret_is_not_a_browser_credential(client, request_kwargs):
    """Only a machine presents the secret, and only as a header. It never rides a cookie or a URL."""
    with _armed(), _stored():
        response = await client.get("/health/status", **request_kwargs)

    assert response.status_code == 403


# ---------------------------------------------------------------------------
# Armed — the three transports
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_machine_header_passes(client):
    with _armed(), _stored():
        response = await client.get("/health/status", headers={"X-Cookie-Gate": SECRET})

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_a_system_grant_cookie_passes(client):
    with _armed(), _stored():
        response = await client.get("/health/status", cookies={COOKIE: _grant()})

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_a_system_ticket_passes_straight_through(client):
    """The ticket is a credential like any other on the first contact — it does not bounce the caller."""
    with _armed(), _stored():
        response = await client.get("/health/status", params={"ticket": _ticket()})

    assert response.status_code == 200
    assert "set-cookie" not in response.headers


@pytest.mark.parametrize("audience", ["admin", "app"])
@pytest.mark.asyncio
async def test_an_audience_doors_credential_does_not_open_the_system_door(client, audience):
    with _armed(), _stored():
        by_cookie = await client.get("/health/status", cookies={COOKIE: _grant(audience)})
        by_ticket = await client.get("/health/status", params={"ticket": _ticket(audience)})

    assert by_cookie.status_code == 403 and by_ticket.status_code == 403


# ---------------------------------------------------------------------------
# The exchange — GET /auth/gate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gate_trades_the_ticket_for_a_grant_cookie(client):
    """The browser's one cold request: the hub admitted it and sent it here with a ticket;
    what it keeps is a grant signed by THIS process — never the secret, never the ticket."""
    from flow_sdk.server import grants

    with _armed(), _stored():
        response = await client.get(f"/auth/gate?ticket={_ticket()}&next=/")

    assert response.status_code == 302
    assert response.headers["location"] == "/"
    assert response.headers["cache-control"] == "no-store"

    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{COOKIE}=")
    assert SECRET not in cookie and _ticket() not in cookie
    with _stored():
        grant = grants.read_grant(_cookie_value(response))
    assert (grant.caller, grant.audience, grant.endpoint) == ("user-alice", "system", ENDPOINT)
    assert "HttpOnly" in cookie
    assert "Secure" in cookie
    assert "Path=/" in cookie
    # Partitioned (CHIPS): the app display embeds a door in an iframe on another port host.
    assert "partitioned" in cookie.lower() and "samesite=none" in cookie.lower()
    # __Host- forbids Domain: e2b.dev is a suffix shared across tenants, so a
    # Domain-scoped cookie would be visible to every other sandbox.
    assert "domain=" not in cookie.lower()
    # Session cookie — closing the browser ends access; the signature carries its own expiry.
    assert "max-age=" not in cookie.lower()
    assert "expires=" not in cookie.lower()


@pytest.mark.asyncio
async def test_gate_honours_a_deep_link(client):
    with _armed(), _stored():
        response = await client.get(f"/auth/gate?ticket={_ticket()}&next=/some/page")

    assert response.headers["location"] == "/some/page"


@pytest.mark.asyncio
async def test_gate_refuses_an_off_origin_next(client):
    """//evil.com is protocol-relative — a browser would leave the origin."""
    with _armed(), _stored():
        response = await client.get(f"/auth/gate?ticket={_ticket()}&next=//evil.com")

    assert response.headers["location"] == "/"


@pytest.mark.asyncio
async def test_gate_leaves_a_clean_url(client):
    with _armed(), _stored():
        response = await client.get(f"/auth/gate?ticket={_ticket()}&next=/")

    assert SECRET not in response.headers["location"] and "ticket" not in response.headers["location"]


@pytest.mark.parametrize("audience", ["admin", "app"])
@pytest.mark.asyncio
async def test_gate_mints_nothing_for_another_doors_ticket(client, audience):
    with _armed(), _stored():
        response = await client.get(f"/auth/gate?ticket={_ticket(audience)}&next=/")

    assert response.status_code == 403  # the middleware never let it in


@pytest.mark.asyncio
async def test_granted_cookie_then_opens_the_app(client):
    """The round trip: trade the ticket, then use the grant on a real route."""
    with _armed(), _stored():
        granted = await client.get(f"/auth/gate?ticket={_ticket()}&next=/")
        assert granted.status_code == 302

        response = await client.get("/health/status", cookies={COOKIE: _cookie_value(granted)})

    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Revocation — POST /auth/revoke, the hub closing doors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_revoke_closes_a_callers_grants_and_only_the_hub_may_say_so(client):
    with _armed(), _stored():
        granted = await client.get(f"/auth/gate?ticket={_ticket()}&next=/")
        value = _cookie_value(granted)
        assert (await client.get("/health/status", cookies={COOKIE: value})).status_code == 200

        by_grant = await client.post(
            "/auth/revoke", json={"caller": "user-alice", "endpoints": [ENDPOINT]}, cookies={COOKIE: value}
        )
        assert by_grant.status_code == 403, "a grant holder cannot revoke anybody"

        revoked = await client.post(
            "/auth/revoke", json={"caller": "user-alice", "endpoints": [ENDPOINT]}, headers={"X-Cookie-Gate": SECRET}
        )
        assert revoked.status_code == 200 and revoked.json()["data"]["revoked"] == 1
        assert (await client.get("/health/status", cookies={COOKIE: value})).status_code == 403

        bad = await client.post("/auth/revoke", json={"endpoints": "x"}, headers={"X-Cookie-Gate": SECRET})
        assert bad.status_code == 400


@pytest.mark.asyncio
async def test_a_restart_invalidates_every_grant(client):
    """The grant key is the secret bound to a boot nonce: a box that comes back serves nobody on a stale cookie."""
    from flow_sdk.server import grants

    with _armed(), _stored():
        granted = await client.get(f"/auth/gate?ticket={_ticket()}&next=/")
        value = _cookie_value(granted)
        with patch.object(grants, "_BOOT_NONCE", "another-boot"):
            response = await client.get("/health/status", cookies={COOKIE: value})

    assert response.status_code == 403


# ---------------------------------------------------------------------------
# What happened just before a refusal (gate_trace)
# ---------------------------------------------------------------------------

_PHONE = {
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) CriOS/157.0.8103.37 Mobile/15E148 Safari/604.1",
    "x-forwarded-for": "2.54.152.88",
    "referer": "https://app.flowpad.ai/open-pc/agent-1",
}


@pytest.mark.asyncio
async def test_a_cookie_dropped_right_after_the_admit_is_named_as_such(client, caplog):
    """The student's case: admitted, cookie set, and the very next request arrives without it.
    The admit is logged with the grant's short id; the refusal points back at it."""
    from flow_sdk.server import gate_trace

    gate_trace.reset_for_tests()
    caplog.set_level("INFO")
    with _armed(), _stored():
        admitted = await client.get(f"/auth/gate?ticket={_ticket()}&next=/dock/vibe/x", headers=_PHONE)
        refused = await client.get("/dock/vibe/x", headers={**_PHONE, "cookie": "_ga=1"})

    gid = gate_trace.short_id(_cookie_value(admitted))
    admit_line = next(r.getMessage() for r in caplog.records if "cookie-gate: admitted" in r.getMessage())
    assert f"grant={gid}" in admit_line and "visitor=user-alice" in admit_line
    # The hub logs the same id for the ticket it handed out (visitor-open: … ticket=), so the two lines join.
    assert f"ticket={gate_trace.short_id(_ticket())}" in admit_line
    assert "referer=app.flowpad.ai" in admit_line and "browser=Chrome_iOS_157" in admit_line

    refusal = next(r.getMessage() for r in caplog.records if "cookie-gate: refused" in r.getMessage())
    assert f"grant_{gid}" in refusal and "last_admit=0." in refusal
    assert "cookies_sent=_ga" in refusal and "referer=app.flowpad.ai" in refusal
    assert "<dt>cookies sent</dt><dd>_ga</dd>" in refused.text
    for text in (admit_line, refusal, refused.text):
        assert SECRET not in text and _cookie_value(admitted) not in text and "2.54.152.88" not in text


@pytest.mark.asyncio
async def test_a_refusal_with_no_admit_says_so(client, caplog):
    from flow_sdk.server import gate_trace

    gate_trace.reset_for_tests()
    with _armed():
        response = await client.get("/dock/vibe/x", headers=_PHONE)

    assert "<dt>last admit</dt><dd>none (this process, this client)</dd>" in response.text
    assert "<dt>cookies sent</dt><dd>none</dd>" in response.text


@pytest.mark.asyncio
async def test_one_refused_page_logs_once_and_points_its_files_at_it(client, caplog):
    from flow_sdk.server import gate_trace

    gate_trace.reset_for_tests()
    caplog.set_level("INFO")
    with _armed():
        first = await client.get("/dock/vibe/x", headers=_PHONE)
        await client.get("/assets/index.js", headers=_PHONE)
        await client.get("/favicon.ico", headers=_PHONE)

    lines = [r.getMessage() for r in caplog.records if "cookie-gate: refused" in r.getMessage()]
    head = first.headers["x-flowpad-gate"].split("request=")[1].split(";")[0]
    assert len(lines) == 3
    assert "last_admit=" in lines[0]
    assert lines[1].endswith(f"(same as request={head})") and lines[2].endswith(f"(same as request={head})")
