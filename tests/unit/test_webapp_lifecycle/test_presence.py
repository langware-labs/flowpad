"""Live connections of served apps: the registry a page's socket keeps (``core/webapp/presence``)."""

from datetime import datetime, timezone

from flow_sdk.core.webapp import presence
from flow_sdk.schema.data_spec.page_state_spec import PageState
from flow_sdk.schema.data_spec.webapp_hosted_spec import PagePresence
from flow_sdk.server import page_state


def _page(webapp_id: str, path: str = "/") -> PagePresence:
    return PagePresence(webapp_id=webapp_id, path=path, since=datetime.now(timezone.utc))


def test_a_page_is_listed_while_it_is_held_and_follows_its_path():
    presence.reset_for_tests()
    first, other = presence.add(_page("app-1")), presence.add(_page("app-2"))

    presence.move(first, "/leads")
    assert [p.path for p in presence.of("micro_app-app-1")] == ["/leads"], "asked by typeid or bare id alike"

    presence.remove(first)
    assert presence.of("app-1") == [] and len(presence.of("app-2")) == 1
    presence.remove(other)


def test_the_opener_is_the_session_the_state_key_was_minted_for(tmp_path, monkeypatch):
    monkeypatch.setattr(page_state, "_path", lambda: tmp_path / "page_states.json")
    page_state.reset_for_tests()
    key = page_state.mint(PageState(context={"process": "agentic_process-abc"}, title="shop"))

    assert presence._opener(key) == "agentic_process-abc"
    assert presence._opener("") == "" and presence._opener("no-such-key-0123456789") == "", "no key: the person"


def test_a_browser_is_named_by_its_most_specific_mark():
    chrome = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    assert presence.browser_family(chrome) == "chrome"
    assert presence.browser_family(chrome + " Edg/140.0") == "edge"
    assert presence.browser_family(chrome.replace("Chrome/140.0", "Flowpad/0.2 Chrome/140.0 Electron/38.0")) == "flowpad"
    assert presence.browser_family("Mozilla/5.0 Version/18.0 Safari/605.1.15") == "safari"
    assert presence.browser_family("curl/8") == "other"
