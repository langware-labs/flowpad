"""``own_sandbox_id`` must not believe ``E2B_SANDBOX_ID``.

This pins a fix that was already made once and did nothing. E2B populates
``E2B_SANDBOX_ID`` only in the interactive shells it spawns; in the server
process started at boot -- the one that serves ``get-host`` -- the variable is
present and EMPTY. Measured on a live box: ``flow_sdk.server.run`` reported
``E2B_SANDBOX_ID=`` while a terminal in the same sandbox reported
``ivshr0pshcpupip2m0pqk``.

A resolver that reads the env therefore passes any test that sets the env and
changes nothing in production, which is exactly what happened. Nothing here is
mocked: the real function runs, and the metadata service really is unreachable
from a dev machine, which is the same "cannot confirm" state a non-sandbox is in.
"""

from flow_sdk.compute.providers.compute_provider import sandbox_public_url
from flow_sdk.instance_settings.runtime import own_sandbox_id


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
