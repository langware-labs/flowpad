from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.claude_memory_entities import Docs
from flow_sdk.builtin.project import Project

pytestmark = pytest.mark.asyncio
GRAPH = "/api/v1/graph"


async def test_default_wiki_and_resolve_actions_use_standard_envelopes(bootstrapped_client):
    default_response = await bootstrapped_client.get(f"{GRAPH}/project/@local/default-wiki")
    assert default_response.status_code == 200, default_response.text
    default_body = default_response.json()
    assert default_body["status"] == "SUCCESS"
    wiki = default_body["data"]
    assert wiki["type"] == "wiki"
    assert wiki["uname"].startswith("wiki-")

    local_alias_response = await bootstrapped_client.get(f"{GRAPH}/wiki/@local")
    assert local_alias_response.status_code == 200, local_alias_response.text
    assert local_alias_response.json()["data"]["id"] == wiki["id"]

    missing_response = await bootstrapped_client.get(
        f"{GRAPH}/wiki/@local/resolve",
        params={"word": "definitely-missing-wiki-word"},
    )
    assert missing_response.status_code == 200, missing_response.text
    assert missing_response.json()["data"] == {"kind": "missing"}

    by_uname_response = await bootstrapped_client.get(
        f"{GRAPH}/wiki/@{wiki['uname']}/resolve",
        params={"word": "definitely-missing-wiki-word"},
    )
    assert by_uname_response.status_code == 200, by_uname_response.text
    assert by_uname_response.json()["data"] == {"kind": "missing"}


async def test_resolve_rejects_blank_word(bootstrapped_client):
    default_response = await bootstrapped_client.get(f"{GRAPH}/project/@local/default-wiki")
    wiki = default_response.json()["data"]
    response = await bootstrapped_client.get(
        f"{GRAPH}/wiki/{wiki['id']}/resolve",
        params={"word": "   "},
    )
    assert response.status_code == 400


async def test_canonical_resolve_bind_and_unbind(bootstrapped_client, tmp_path):
    default_response = await bootstrapped_client.get(f"{GRAPH}/project/@local/default-wiki")
    wiki = default_response.json()["data"]
    project = await Project.get_by_uname("local")
    assert project is not None

    implicit = Docs(
        id=mint_uuid(),
        name="CanonicalWord",
        uname=f"canonical-{mint_uuid()}",
        title="CanonicalWord",
        asset_ref=str(tmp_path / "canonical.md"),
        project_id=str(project.id),
    )
    explicit = Docs(
        id=mint_uuid(),
        name="ExplicitTarget",
        uname=f"explicit-{mint_uuid()}",
        title="ExplicitTarget",
        asset_ref=str(tmp_path / "explicit.md"),
        project_id=str(project.id),
    )
    await implicit.save()
    await explicit.save()

    resolve_url = f"{GRAPH}/wiki/{wiki['id']}/resolve"
    implicit_response = await bootstrapped_client.get(resolve_url, params={"word": "CanonicalWord"})
    assert implicit_response.json()["data"] == {
        "kind": "resolved",
        "target_typeid": str(implicit.typeid),
        "source": "implicit",
    }

    bind_response = await bootstrapped_client.post(
        f"{GRAPH}/wiki/{wiki['id']}/bind",
        json={"word": "CanonicalWord", "target_typeid": str(explicit.typeid)},
    )
    assert bind_response.status_code == 200, bind_response.text
    assert bind_response.json()["data"]["target_typeid"] == str(explicit.typeid)
    explicit_response = await bootstrapped_client.get(resolve_url, params={"word": "CanonicalWord"})
    assert explicit_response.json()["data"] == {
        "kind": "resolved",
        "target_typeid": str(explicit.typeid),
        "source": "entry",
    }
    assert "asset_ref" not in explicit_response.json()["data"]

    unbind_response = await bootstrapped_client.delete(
        f"{GRAPH}/wiki/{wiki['id']}/unbind",
        params={"word": "CanonicalWord"},
    )
    assert unbind_response.status_code == 200, unbind_response.text
    rebound = await bootstrapped_client.get(resolve_url, params={"word": "CanonicalWord"})
    assert rebound.json()["data"]["target_typeid"] == str(implicit.typeid)
