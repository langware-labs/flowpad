"""Unit tests for the hub/desktop page selection at bootstrap.

`_resolve_supported_pages` decides which SPA page(s) the local desktop server
advertises. It now serves BOTH `desk` and `hub` unconditionally — `desk` first
so it stays the default landing home, `hub` also so the hub page's dock URLs are
reachable in the same build. See flow_sdk/server/routes/bootstrap.py.
"""
from flow_sdk.server.routes import bootstrap


def test_serves_both_desk_and_hub():
    # `desk` must come first so an unqualified dock lands on the desktop home
    # (and isHubOnly() stays false), with `hub` also advertised.
    assert bootstrap._resolve_supported_pages() == ["desk", "hub"]
