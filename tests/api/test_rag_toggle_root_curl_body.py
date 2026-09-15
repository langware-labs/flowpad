"""``rag-toggle-root`` accepts the body exactly as ``docs/snippets/rag.md`` sends it.

The snippet is ``curl -X POST … -d '{"path": …}'`` with no ``-H``, so the body is JSON labelled
``application/x-www-form-urlencoded``. The shared request parser used to read that as a form,
hand the action ``{}``, and answer 400 "path is required".
"""

import json

import pytest

pytestmark = [pytest.mark.usefixtures("reset_db_for_testclient"), pytest.mark.timeout(30)]

_FORM = {"content-type": "application/x-www-form-urlencoded"}


async def test_toggle_root_with_curl_d_form_content_type(bootstrapped_client, tmp_path):
    folder = tmp_path / "notes"
    folder.mkdir()
    body = json.dumps({"path": str(folder)})

    on = await bootstrapped_client.post("/api/v1/graph/rag-toggle-root", content=body, headers=_FORM)
    assert on.status_code == 200, on.text
    assert on.json()["data"]["covered"] is True
    assert str(folder) in on.json()["data"]["roots"]

    off = await bootstrapped_client.post("/api/v1/graph/rag-toggle-root", content=body, headers=_FORM)
    assert off.status_code == 200, off.text
    assert off.json()["data"]["covered"] is False
