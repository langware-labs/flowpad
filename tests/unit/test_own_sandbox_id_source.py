"""``own_sandbox_id`` must not believe ``E2B_SANDBOX_ID``.

This pins a fix that was already made once and did nothing. E2B populates
``E2B_SANDBOX_ID`` only in the interactive shells it spawns; in the server
process started at boot -- the one that answers ``direct-url`` -- the variable is
present and EMPTY. Measured on a live box: ``flow_sdk.server.run`` reported
``E2B_SANDBOX_ID=`` while a terminal in the same sandbox reported
``ivshr0pshcpupip2m0pqk``.

A resolver that reads the env therefore passes any test that sets the env and
changes nothing in production, which is exactly what happened. Nothing here is
mocked: the real function runs, and the metadata service really is unreachable
from a dev machine, which is the same "cannot confirm" state a non-sandbox is in.
"""

from flow_sdk.compute.providers.compute_provider import sandbox_public_url
from flow_sdk.instance_settings import reset_instance_settings
from flow_sdk.instance_settings.runtime import own_sandbox_id, set_assigned_runtime
from flow_sdk.models.bootstrap_models import RuntimeKind


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.sandbox_browser_url.rules: FAILING? read this tag's rules before
#       editing. The sandbox id does NOT come from E2B_SANDBOX_ID — it is empty in the
#       server process.
# flowpad:endcapsule tag
def test_a_populated_env_var_does_not_make_this_a_sandbox(monkeypatch):
    own_sandbox_id.cache_clear()
    monkeypatch.setenv("E2B_SANDBOX", "true")
    monkeypatch.setenv("E2B_SANDBOX_ID", "env-var-value-that-must-not-be-trusted")
    try:
        assert own_sandbox_id() is None, (
            "the env var was echoed back; a box would hand out preview urls built "
            "from whatever happened to be in the environment"
        )
    finally:
        own_sandbox_id.cache_clear()


def test_a_plain_machine_never_claims_to_be_a_sandbox(monkeypatch):
    own_sandbox_id.cache_clear()
    monkeypatch.delenv("E2B_SANDBOX", raising=False)
    try:
        assert own_sandbox_id() is None
    finally:
        own_sandbox_id.cache_clear()


def test_public_url_shape_matches_what_e2b_serves():
    assert sandbox_public_url(8000, "ivshr0pshcpupip2m0pqk") == ("https://8000-ivshr0pshcpupip2m0pqk.e2b.dev")


class _FakeMmdsResponse:
    def __init__(self, data: bytes):
        self._data = data

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def read(self):
        return self._data


def test_a_cache_hit_before_the_hub_assigns_sandbox_outlives_the_assignment(monkeypatch, tmp_path):
    """RCA (prod compute_node f41f5c42-a8fa-4934-8cda-9080f09d24bd, 2026-09-24):
    ``own_sandbox_id`` is ``@lru_cache(maxsize=1)`` for the process lifetime.
    Something asks it (an early ``ops/status`` call, a preview-url builder --
    ``local_direct_url`` in ``flow_sdk/builtin/service_endpoint.py``) before
    ``/auth/login_callback`` has run ``set_assigned_runtime(SANDBOX)`` for this
    boot. That first call sees an unassigned runtime, answers ``None``, and
    the decorator locks that answer in for good.

    ``set_assigned_runtime`` — the ONE writer login_callback calls after the
    hub's api-key validates — updated ``get_assigned_runtime``'s own cache
    correctly (see its ``_cache[key] = assigned`` line), but had no idea
    ``own_sandbox_id`` existed, let alone that it needed invalidating too.
    (``reset_cache``/``reset_instance_settings``, the test-only reset path,
    already cleared both — this gap was specific to the real runtime path.)

    Reproduced live: ``cloud_login()``'s ``own_sandbox_id()`` call kept
    returning ``None`` long after the sandbox was correctly assigned, so
    ``login()`` built ``/api/v1/login?target_path=http://127.0.0.1:9007/...``
    (the desktop-app url shape) instead of
    ``/oauth/authorize?...&redirect_uri=https://9007-<id>.e2b.dev/...`` (the
    sandbox url shape) — a url no real browser can ever reach. The only fix
    that worked without a code change was restarting the sandbox's own
    process, which drops the lru_cache.
    """
    monkeypatch.delenv("FLOW_INSTANCE", raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "rca-own-sandbox-id-race")
    reset_instance_settings()
    own_sandbox_id.cache_clear()

    def fake_urlopen(req, timeout=None):
        # The token PUT and the instance-id GET share this fake -- differentiate
        # on the real Request object's method, exactly like own_sandbox_id does.
        if req.get_method() == "PUT":
            return _FakeMmdsResponse(b"fake-mmds-token")
        return _FakeMmdsResponse(b"real-sandbox-id-123")

    monkeypatch.setattr("flow_sdk.instance_settings.runtime.urlopen", fake_urlopen)

    try:
        # The early caller: boot-time, before login_callback has assigned
        # anything. own_sandbox_id has every right to answer None here --
        # this call is not the bug.
        assert own_sandbox_id() is None

        # The hub now validates the api-key and assigns this instance as a
        # sandbox -- exactly what /auth/login_callback does.
        set_assigned_runtime(RuntimeKind.SANDBOX)

        # A FRESH computation right now would succeed -- the fake MMDS is
        # ready and answering -- so the assignment itself is not what is
        # broken. Only the stale lru_cache stands between here and the real id.
        assert own_sandbox_id() == "real-sandbox-id-123", (
            "own_sandbox_id() kept serving the pre-assignment None after the "
            "hub assigned this instance as SANDBOX -- the exact bug that left "
            "a live prod sandbox building an unreachable 127.0.0.1 login url "
            "until its process was restarted by hand"
        )
    finally:
        own_sandbox_id.cache_clear()
        reset_instance_settings()
