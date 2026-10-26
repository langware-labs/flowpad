from flow_sdk.assets.flow_json import parse
from flow_sdk.builtin.hub_dependencies import hub_dependency_ids

WAHA = "126562ce-e0c5-4b8f-80bc-4bd832c58365"
OTHER = "fe44fc4e-dc52-4c7b-a9d7-9309920eb844"


def test_a_required_hub_dependency_is_granted():
    spec = parse('{"dependencies": {"waha": "hub:%s"}}' % WAHA)
    assert hub_dependency_ids(spec) == [WAHA]


def test_git_and_optional_dependencies_are_not():
    spec = parse(
        '{"dependencies": {'
        '"gh": "git+https://github.com/langware-labs/waha-service#main",'
        '"waha": "hub:%s"},'
        '"optionalDependencies": {"opt": "hub:%s"}}' % (WAHA, OTHER)
    )
    assert hub_dependency_ids(spec) == [WAHA]


def test_no_flow_json_grants_nothing():
    assert hub_dependency_ids(parse("{}")) == []
