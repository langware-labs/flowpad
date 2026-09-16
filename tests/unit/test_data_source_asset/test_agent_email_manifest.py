"""Agent Email is what people are offered; the mail vendor behind it is not.

``cloud_email`` is the mailbox the cloud allocates for an agent, so its manifest is
``provisioned`` and has no field a person fills — allocation writes the agent id.
``agentmail`` is that vendor reached directly: still a loadable source (its rows poll,
scripts name it), but ``listed: false`` keeps it out of the add-source picker.
"""
from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, asset_module, read_manifest


def test_agent_email_is_provisioned_and_names_no_vendor():
    manifest = read_manifest(SHIPPED_ROOT / "cloud_email")
    assert manifest.title == "Agent Email"
    assert manifest.provisioned is True
    assert "agentmail" not in f"{manifest.title} {manifest.description} {manifest.icon_name}".lower()
    config = asset_module("cloud_email").CloudEmailConfig
    assert all(not field.is_required() for field in config.model_fields.values()), "nobody fills this form"


def test_the_vendor_is_loadable_but_not_offered():
    assert read_manifest(SHIPPED_ROOT / "agentmail").listed is False
