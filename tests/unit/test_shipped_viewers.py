"""The shipped viewers: each names kinds that exist (or ``*``), ships the module it declares, and its
manifest round-trips -- a typo in ``views`` would silently show a kind generically forever."""

from __future__ import annotations

import json

import pytest

from flow_sdk.config import flowpad_assistant_project_root
from flow_sdk.schema.data_spec.webapp_spec import WebappManifestSpec
from flow_sdk.server.routes.kinds import kind_form

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

ASSETS = flowpad_assistant_project_root() / "agentic-assets"
VIEWERS = [p.parent for p in (ASSETS / "webapp").glob("*/webapp.json") if json.loads(p.read_text()).get("kind") == "application.web.viewer"]


def test_the_three_viewers_ship():
    assert {v.name for v in VIEWERS} >= {"data-viewer", "eval-viewers", "navigator-viewers"}


@pytest.mark.parametrize("folder", VIEWERS, ids=lambda p: p.name)
def test_a_shipped_viewer_names_real_kinds_and_ships_its_module(folder):
    spec = WebappManifestSpec.model_validate_json((folder / "webapp.json").read_text())
    assert spec.views, "a viewer shows something"
    for view in spec.views:
        # The same registry `GET /api/v1/kinds` answers from -- a code kind or a data_spec folder alike.
        assert view.kind == "*" or kind_form(view.kind) is not None, view.kind
    assert (folder / spec.module).is_file()
    assert WebappManifestSpec.model_validate(spec.model_dump()) == spec
