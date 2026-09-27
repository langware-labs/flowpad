"""A page's reported state belongs to THAT page — including a web page.

``flow show url`` made web pages a display target. Target identity compared a fixed key
list that had no ``url``, so every web page was the same target: the state a docs page
reported stayed "fresh" after the agent showed a different site.
"""
from __future__ import annotations

from flow_sdk.builtin.agentic_process.display_context import fresh_display_context, with_display_context

PAGE_A = {"kind": "url", "url": "https://metallb.io/installation/"}
PAGE_B = {"kind": "url", "url": "https://cert-manager.io/docs/installation/"}


def test_state_reported_by_one_web_page_is_not_fresh_on_another():
    written = with_display_context({"last_shown": PAGE_A}, {"step": 2})
    assert written is not None and fresh_display_context(written) is not None

    moved_on = {**written, "last_shown": PAGE_B}
    assert fresh_display_context(moved_on) is None


def test_the_same_web_page_keeps_its_state():
    written = with_display_context({"last_shown": PAGE_A}, {"step": 2})
    assert fresh_display_context({**written, "last_shown": dict(PAGE_A)})["data"] == {"step": 2}
