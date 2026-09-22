"""A served page learns the process it is shown beside — and nothing else.

``fs/serve`` writes ``__FLOWPAD_PROCESS_ID__`` into the page from the ``process``
query parameter, next to ``__FLOWPAD_API_URL__``. The value comes off a url, so
only a well-formed UUID may ever reach the document.
"""

import pytest

from flow_sdk.builtin.faas.serve_static import inject_api_origin, inject_process_id

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PID = "3f2a1b4c-0000-4000-8000-0000000000aa"


def test_the_process_id_is_set_before_the_pages_own_scripts():
    html = inject_process_id(inject_api_origin("<html><head><script>page()</script></head></html>"), PID)
    head = html.split("<script>page()")[0]
    assert f'globalThis.__FLOWPAD_PROCESS_ID__="{PID}"' in head
    assert "__FLOWPAD_API_URL__" in head


def test_it_is_idempotent():
    once = inject_process_id("<head></head>", PID)
    assert inject_process_id(once, PID) == once


@pytest.mark.parametrize("value", [None, "", "not-a-uuid", f'{PID}";alert(1);//'])
def test_anything_but_a_uuid_leaves_the_page_untouched(value):
    html = "<html><head></head><body></body></html>"
    assert inject_process_id(html, value) == html
