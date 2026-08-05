"""What cloud sharing puts on the wire — pinned against the code AND the doc.

`docs/collab/cloud-sharing.md` makes a privacy promise. A promise nothing
enforces goes stale the first time somebody adds a field to `Project`, and the
failure is silent: the page still says "we don't upload that" while the code
has started uploading it.

So the fixture is an independent third statement, exactly like
`asset_editor_contract.json`:

* code → fixture catches a field whose classification changed;
* fixture → doc catches somebody fixing the first failure by editing the
  fixture and walking away.

Neither can be satisfied alone. Adding a field to `Project` therefore forces a
deliberate answer to "does this travel?" and forces the page to say so.
"""

import json
import re
from pathlib import Path

import pytest

from flow_sdk.assets.projection import _LOCAL_OR_RUNTIME_FIELDS, PortableAssetProjection
from flow_sdk.builtin.project import Project

ROOT = Path(__file__).parent.parent.parent
CONTRACT = json.loads((ROOT / "tests" / "fixtures" / "cloud_share_contract.json").read_text())
BUCKETS = CONTRACT["project_field_buckets"]


@pytest.fixture()
def project() -> Project:
    return Project(id="11111111-1111-4111-8111-111111111111", name="demo", fs_storage_mount_path="/tmp/demo")


def test_every_project_field_is_classified():
    """The assertion that makes this contract worth having.

    A new field on `Project` lands in none of the four buckets and fails here,
    with its own name in the message — so the author has to decide whether it
    travels before they can go green.
    """
    classified = [f for bucket in BUCKETS.values() for f in bucket]
    assert len(classified) == len(set(classified)), "a field is in two buckets"
    assert set(Project.model_fields) == set(classified), (
        "unclassified Project field(s): "
        f"{sorted(set(Project.model_fields) - set(classified))} — add each to a bucket in "
        "tests/fixtures/cloud_share_contract.json and document it in docs/collab/cloud-sharing.md"
    )


def test_the_always_travels_bucket_is_exactly_what_hub_body_emits(project):
    body = project._hub_body()
    assert sorted(f for f in body if f in Project.model_fields) == BUCKETS["hub_always"]


def test_withheld_and_stripped_fields_really_do_not_travel(project):
    body = project._hub_body()
    for field in BUCKETS["withheld_by_declaration"] + BUCKETS["stripped_by_hub_body"]:
        assert field not in body, f"{field} was supposed to be withheld but is on the wire"


def test_declaration_withheld_fields_are_withheld_by_their_declaration(project):
    """Two different mechanisms hide a field, and they fail differently.

    A declaration-withheld field stays hidden even if `_hub_body` is rewritten;
    a popped one is hidden only for as long as the `pop()` line survives.
    """
    not_sent = Project.fields_not_sent_to_hub()
    for field in BUCKETS["withheld_by_declaration"]:
        assert field in not_sent, f"{field} is no longer declaration-withheld"


def test_the_dead_pops_are_still_dead():
    """`_hub_body` pops three names that are computed properties, not fields.

    `model_dump()` never emits them, so the pops have always been no-ops. They
    are harmless, but pinned here so nobody reads them as evidence that a field
    called `secret_origins` is being stripped — and so that if one of them ever
    becomes a real field, this fails and forces a real decision.
    """
    for name in CONTRACT["stripped_names_that_are_not_fields"]:
        assert name not in Project.model_fields, f"{name} is now a real field — classify it"


def test_share_puts_three_stripped_fields_back(project):
    """The surprise the doc exists to state.

    `_hub_body()` strips these, and then `Project.share()` adds them back to
    the body. A reader who stops at `_hub_body` gets the wrong answer.
    """
    for field in CONTRACT["readded_by_share"]:
        assert field not in project._hub_body()
    source = (ROOT / "flow_sdk" / "builtin" / "project.py").read_text()
    share_src = source[source.index("    async def share("):]
    share_src = share_src[: share_src.index("\n    async def ", 10)]
    for field in CONTRACT["readded_by_share"]:
        assert f'body["{field}"]' in share_src, f"share() no longer re-adds {field}"


def test_a_secret_declaration_carries_no_value():
    entry_fields = set(CONTRACT["secret_entry_fields"])
    assert "value" not in entry_fields
    source = (ROOT / "flow_sdk" / "builtin" / "project.py").read_text()
    payload_src = source[source.index("    async def _shared_secret_origin_payload("):]
    payload_src = payload_src[: payload_src.index("\n    async def ", 10)]
    for field in entry_fields:
        assert f'"{field}"' in payload_src, f"secret payload no longer carries {field}"
    # The machine-specific coordinate is stripped from a local locator.
    for stripped in CONTRACT["secret_locator_stripped_for_local"]:
        assert f'locator.pop("{stripped}"' in payload_src


def test_a_git_published_asset_sends_metadata_and_coordinates_only():
    assert sorted(PortableAssetProjection.model_fields) == CONTRACT["portable_asset_projection_fields"]
    assert sorted(_LOCAL_OR_RUNTIME_FIELDS) == CONTRACT["portable_asset_local_or_runtime_fields"]
    # No body/content field anywhere in the projection — the bytes stay in git.
    assert not {"body", "content", "text", "bytes"} & set(PortableAssetProjection.model_fields)


def test_the_doc_lists_exactly_what_the_fixture_says():
    """fixture → doc. Without this, fixing any failure above is a one-line edit
    to the fixture and the page quietly becomes a lie."""
    doc = (ROOT / CONTRACT["doc_path"]).read_text()
    expected = {
        "always": BUCKETS["hub_always"],
        "when-set": BUCKETS["hub_when_set"],
        "withheld": BUCKETS["withheld_by_declaration"] + BUCKETS["stripped_by_hub_body"],
        "readded": CONTRACT["readded_by_share"],
        "secret-entry": CONTRACT["secret_entry_fields"],
    }
    for name, fields in expected.items():
        match = re.search(rf"<!-- pinned:{name} -->(.*?)<!-- pinned:/{name} -->", doc, re.S)
        assert match, f"docs/collab/cloud-sharing.md is missing the <!-- pinned:{name} --> block"
        listed = set(re.findall(r"`([a-z_][a-z0-9_]*)`", match.group(1)))
        assert listed == set(fields), (
            f"the pinned:{name} block in {CONTRACT['doc_path']} disagrees with the fixture; "
            f"missing={sorted(set(fields) - listed)} extra={sorted(listed - set(fields))}"
        )
