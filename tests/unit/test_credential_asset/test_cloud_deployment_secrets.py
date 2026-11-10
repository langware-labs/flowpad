"""A cloud deployment keeps its values in the hub store; "use mine" copies this computer's values there;
a missing value warns and the deploy proceeds; deleting a credential reaches the hub.
The hub is an in-memory double (``tests/utils/fake_hub_store``). No network."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_cloud_deploy import funding_warnings
from flow_sdk.builtin.credential_service import CredentialError, delete_credential, save_credential, use_mine
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.readiness import readiness
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.schema.data_spec.requirement_spec import RequirementSpec
from flow_sdk.secrets import SecretStore
from tests.utils import fake_hub_store
from tests.utils.deploy_run import deploy_ended, plan_for

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

VALUE = "sk-live-never-shown"


@pytest.fixture
def hub(monkeypatch):
    return fake_hub_store.install(monkeypatch)


async def _agent(project) -> Agent:
    agent = Agent(name="cloud-agent", project_id=str(project.id),
                  requirements=[RequirementSpec(kind="credential", name="stripe", vars=["STRIPE_KEY"])])
    await agent.save()
    return agent


async def _stripe_here(project) -> None:
    await save_credential(scope="project", project_id=str(project.id),
                          manifest={"name": "stripe", "vars": {"STRIPE_KEY": {}}, "setup": "x"}, values={"STRIPE_KEY": VALUE})


async def test_a_planned_cloud_deployment_keeps_its_values_in_the_hub_and_keeps_that_across_adoptions(home, project, hub):
    agent = await _agent(project)

    deployment = await plan_for(agent, "production", provider="e2b")
    again = await plan_for(agent, "production", provider="e2b", deployment_id=str(deployment.id))
    another = await plan_for(agent, "production", provider="e2b")

    assert deployment.remote and deployment.secrets.store.type == "hub"
    assert again.id == deployment.id and again.secrets == deployment.secrets, "a plan naming its row keeps it"
    assert another.id != deployment.id, "a plan naming none is a new placement"


async def test_the_hub_store_takes_values_lists_names_and_never_gives_one_back(home, project, hub):
    store = await SecretStore.get("hub", {"deployment_id": "d-1"})

    await store.save({"STRIPE_KEY": VALUE})
    await store.save({"STRIPE_KEY": VALUE + "-rotated"})

    assert await store.names() == ["STRIPE_KEY"] and hub.values["d-1"]["STRIPE_KEY"] == VALUE + "-rotated"
    assert await store.load(["STRIPE_KEY"]) == {}
    assert [c[0] for c in hub.calls if c[0] in ("POST", "PUT")] == ["POST", "PUT"]
    assert VALUE not in json.dumps(hub.calls), "only payload keys are ever recorded (and logged)"
    assert await store.forget(["STRIPE_KEY", "NEVER"]) == (["STRIPE_KEY"], [])


async def test_a_missing_value_warns_the_deploy_proceeds_and_use_mine_fills_it_later(home, project, hub, monkeypatch):
    agent = await _agent(project)
    await _stripe_here(project)
    monkeypatch.setattr(Agent, "ensure_on_hub", _published)  # publishing is the git path's; not under test here
    monkeypatch.setattr("flow_sdk.builtin.project.Project.ensure_on_hub", AsyncMock(return_value=False))

    ended = await deploy_ended(agent, "user-1", "production", provider="e2b")
    assert "Secret stripe missing" in ended.model_dump_json(), "the readiness step says what is missing"
    assert len(hub.deploys) == 1, "a missing secret never refuses the deploy: the machine starts"
    deployment_id = hub.deploy_ids[0]

    assert await use_mine(deployment_id) == {"copied": ["STRIPE_KEY"], "not_here": [], "hub_funded": []}
    assert hub.values[deployment_id] == {"STRIPE_KEY": VALUE}


async def test_a_protected_deployment_refuses_use_mine(home, project, hub):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = await plan_for(agent, "production", provider="e2b")
    deployment.secrets = deployment.secrets.model_copy(update={"protected": True})
    await deployment.save()

    with pytest.raises(CredentialError, match="protected"):
        await use_mine(str(deployment.id))
    assert hub.values.get(str(deployment.id)) is None


async def test_deleting_a_credential_removes_its_value_from_the_hub_too(home, project, hub):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = await plan_for(agent, "production", provider="e2b")
    await use_mine(str(deployment.id))
    from flow_sdk.builtin.credential import Credential

    spec = await Credential.get("stripe", project)
    result = await delete_credential(str(spec.typeid))

    assert result.removed and hub.values[str(deployment.id)] == {}
    assert ("hub", ["STRIPE_KEY"]) in [(s.type, s.deleted) for s in result.stores]


async def _published(self, actor, force=False):
    return False


async def test_an_oauth_need_on_a_cloud_deployment_needs_the_owners_authorization(home, project, hub, monkeypatch):
    from flow_sdk.builtin.readiness import readiness
    from flow_sdk.schema.data_spec.connection_spec import ConnectionSpec
    from tests.utils.connection_rows import fake_connections

    agent = Agent(name="cloud-slack", project_id=str(project.id),
                  requirements=[RequirementSpec(kind="connection", name="slack")])
    await agent.save()
    fake_connections(monkeypatch, {"slack": ConnectionSpec(provider="slack", display_name="Slack", connected=True)})
    deployment = await plan_for(agent, "production", provider="e2b")

    before = (await readiness(agent, deployment)).items
    assert [(i.status, i.fix) for i in before] == [("missing", "authorize slack for this deployment")]

    await deployment.authorize("slack", ["permission.slack.chat.write"])
    after = await readiness(agent, deployment)
    assert after.ready and after.items[0].status == "verified"


async def test_flow_credentials_diff_then_use_mine_closes_the_gap(home, project, hub, run_flow):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = str((await plan_for(agent, "production", provider="e2b")).id)
    diff = ("credentials", "diff", "here", deployment, "--project", str(project.id))

    before = json.loads((await run_flow(*diff)).stdout)
    copied = await run_flow("credentials", "use-mine", deployment, "--name", "STRIPE_KEY")
    after = json.loads((await run_flow(*diff)).stdout)

    assert [r["name"] for r in before["differ"]] == ["STRIPE_KEY"]
    assert before["differ"][0][deployment]["store"] == "hub"
    assert copied.exit_code == 0 and json.loads(copied.stdout)["copied"] == ["STRIPE_KEY"]
    assert VALUE not in copied.stdout + json.dumps(before) + json.dumps(after)
    assert after["differ"] == []


async def test_flow_credentials_check_and_set_take_a_deployment(home, project, hub, run_flow):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = str((await plan_for(agent, "production", provider="e2b")).id)
    check = ("credentials", "check", "stripe", "--project", str(project.id), "--deployment", deployment)

    missing = await run_flow(*check)
    set_ = await run_flow("credentials", "set", "stripe", "--stdin", "--project", str(project.id),
                          "--deployment", deployment, input=f"STRIPE_KEY={VALUE}\n")
    ready = await run_flow(*check)

    assert (missing.exit_code, ready.exit_code) == (1, 0), (missing.stdout, set_.stdout, ready.stdout)
    assert hub.values[deployment] == {"STRIPE_KEY": VALUE}
    assert VALUE not in set_.stdout


_REQUEST: list = []


def _request(monkeypatch, body: dict):
    from unittest.mock import AsyncMock

    from flow_sdk.request_context.request_info import RequestInfo

    info = RequestInfo()
    info.get_post_data = AsyncMock(return_value=body)
    monkeypatch.setattr("flow_sdk.builtin.agent.get_current_request_info", lambda: info)
    _REQUEST[:] = [info]
    monkeypatch.setattr("flow_sdk.request_context.methods.get_current_request_info", lambda: info)


async def _plan_over_rest(agent):
    """`POST project/<id>/plan_deployment` naming the agent as main."""
    (info,) = _REQUEST
    info.get_post_data.return_value = {**info.get_post_data.return_value, "main_agent_id": str(agent.typeid)}
    return await (await agent._owning_project()).plan_deployment_action()


async def test_the_deploy_dialog_plans_then_authorizes_and_revokes_over_rest(home, project, hub, monkeypatch):
    agent = await _agent(project)

    _request(monkeypatch, {"environment": "staging", "provider": "e2b"})
    planned = (await _plan_over_rest(agent)).data
    deployment = await Deployment.get_by_id(planned["deployment"]["id"])
    _request(monkeypatch, {"provider": "google"})
    granted = await deployment.authorize_action()
    held = (await deployment.secrets_action()).data
    _request(monkeypatch, {"provider": "google", "revoke": True})
    revoked = (await deployment.authorize_action()).data
    _request(monkeypatch, {})
    refused = await deployment.authorize_action()

    assert planned["deployment"]["environment"] == "staging"
    assert [(i["requirement"]["name"], i["status"]) for i in planned["readiness"]["items"]] == [("stripe", "missing")]
    assert granted.status == "SUCCESS" and held["authorizations"] == [{"provider": "google"}]
    assert revoked == {"revoked": ["google"]} and hub.authorized[str(deployment.id)] == []
    assert refused.status_code == 400


async def test_changing_an_allocation_names_its_deployment_and_a_new_deployment_names_none(
    home, project, hub, monkeypatch
):
    """The deployment panel's "Change allocation" (`POST project/<id>/plan_deployment` naming the row's
    `deployment_id`) lands on that row; the same request naming none is a new deployment's, and plans a new one."""
    agent = await _agent(project)
    allocation = {"source": f"llm_endpoint-{'5' * 8}-5555-4555-8555-{'5' * 12}", "cost_usd_per_day": 0.1,
                  "model": "openai/gpt-5"}
    _request(monkeypatch, {"environment": "production", "provider": "e2b"})
    existing = (await _plan_over_rest(agent)).data["deployment"]

    _request(monkeypatch, {"environment": "production", "provider": "e2b", "token_allocation": allocation,
                           "deployment_id": existing["id"]})
    changed = (await _plan_over_rest(agent)).data["deployment"]
    _request(monkeypatch, {"environment": "production", "provider": "e2b", "token_allocation": allocation})
    new = (await _plan_over_rest(agent)).data["deployment"]

    assert changed["id"] == existing["id"], "the change lands on the deployment being changed"
    assert not existing["llm_endpoint_typeid"] and changed["llm_endpoint_typeid"], "it now has its own allocation"
    assert (await Deployment.get_by_id(existing["id"])).llm_endpoint_typeid == changed["llm_endpoint_typeid"]
    assert new["id"] != existing["id"] and new["llm_endpoint_typeid"], "a new deployment is a new placement"
    assert [r["id"] for r in hub.planned(f"project-{agent.project_id}", "production")] == [existing["id"], new["id"]]


async def test_use_mine_never_copies_an_llm_provider_key(home, project, hub):
    """A deployment is hub-funded: the key a laptop pays its own model calls with stays on the laptop."""
    agent = await _agent(project)
    await save_credential(scope="user", manifest={"name": "openrouter", "vars": {"OPENROUTER_API_KEY": {}},
                                                  "setup": "x", "lm_provider": "openrouter"},
                          values={"OPENROUTER_API_KEY": "sk-or-mine"})
    deployment = await plan_for(agent, "production", provider="e2b")

    result = await use_mine(str(deployment.id), ["OPENROUTER_API_KEY"])

    assert result == {"copied": [], "not_here": [], "hub_funded": ["OPENROUTER_API_KEY"]}
    assert "OPENROUTER_API_KEY" not in hub.values.get(str(deployment.id), {})


async def test_a_cloud_deployment_that_cannot_pay_for_a_turn_is_still_ready_and_says_which_limit(home, project, hub):
    agent = await _agent(project)
    await _stripe_here(project)
    deployment = await plan_for(agent, "production", provider="e2b")
    await use_mine(str(deployment.id))

    unknown = await readiness(agent, deployment)
    hub.funding[str(deployment.id)] = {"kind": "allocation", "name": "cloud-agent tokens", "exhausted": ""}
    funded = await readiness(agent, deployment)
    hub.funding[str(deployment.id)]["exhausted"] = "limit 'cost_usd_per_day' used up on cloud-agent tokens"
    spent = await readiness(agent, deployment)

    assert unknown.ready and not [i for i in unknown.items if i.requirement.kind == "funding"], "a hub that cannot say blocks nothing"
    (item,) = [i for i in funded.items if i.requirement.kind == "funding"]
    assert funded.ready and item.status == "verified" and item.where == "cloud-agent tokens (its token allocation)"
    (item,) = [i for i in spent.items if i.requirement.kind == "funding"]
    # Missing, and said — but funding never refuses a deploy: the placement runs, its turns wait for the limit.
    assert spent.ready and item.status == "missing" and not item.blocks and "cost_usd_per_day" in item.fix
    assert funding_warnings(agent, spent) == [f"No LLM funding for cloud-agent: {item.fix}"]
    assert "funding" not in {r.kind for r in agent.requirements or []}, "asked at readiness, never written to the agent"


async def test_a_deploy_naming_no_provider_leaves_the_choice_to_the_hub(home, project, hub, monkeypatch):
    agent = Agent(name="any-cloud", project_id=str(project.id))
    await agent.save()
    monkeypatch.setattr(Agent, "ensure_on_hub", _published)
    monkeypatch.setattr("flow_sdk.builtin.project.Project.ensure_on_hub", AsyncMock(return_value=False))

    await deploy_ended(agent, "user-1", "production")
    await deploy_ended(agent, "user-1", "production", provider="gcp_vm")
    assert [d["provider"] for d in hub.deploys] == [None, "gcp_vm"]


def _slack_credential() -> dict:
    """The Slack driver's own credential: a bot token, a user token or a sign-in, any one of them."""
    folder = Path(asset_module("slack").__file__).parent / "agentic-assets" / "credential" / "slack_channel"
    return {**json.loads((folder / "credential.json").read_text(encoding="utf-8")), "setup": "x"}


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.one_of_api_key.rules: FAILING? read this tag's rules before touching
#       readiness() api-key branch or _needed_names
# flowpad:endcapsule tag
async def test_a_slack_source_on_its_bot_token_deploys_without_a_user_token(home, project, hub, monkeypatch):
    """FLOWPAD-2339: the driver names SLACK_USER_TOKEN for each permission, but any way of the credential grants them."""
    await DataDriver.find("slack")
    agent = Agent(name="cloud-slack-bot", project_id=str(project.id))
    await agent.save()
    await make_data_source("slack", name="Slack bot", owner=f"agent-{agent.id}").save()
    await save_credential(scope="project", project_id=str(project.id), manifest=_slack_credential(), values={"SLACK_BOT_TOKEN": VALUE})
    monkeypatch.setattr(Agent, "ensure_on_hub", _published)  # publishing is the git path's; not under test here
    monkeypatch.setattr("flow_sdk.builtin.project.Project.ensure_on_hub", AsyncMock(return_value=False))
    deployment = await plan_for(agent, "production", provider="e2b")

    copied = await use_mine(str(deployment.id))

    assert copied["copied"] == ["SLACK_BOT_TOKEN"], f"the token the source runs on is what gets copied: {copied}"
    await deploy_ended(agent, "user-1", "production", provider="e2b", deployment_id=str(deployment.id))
    assert len(hub.deploys) == 1
