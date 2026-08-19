from pathlib import Path

DEMO = Path(__file__).parents[2] / "examples" / "deployed-agent-chat" / "index.html"


def test_demo_uses_the_existing_sdk_surface_only() -> None:
    source = DEMO.read_text()

    expected_calls = (
        "sdk.Agent.getById",
        "agent.use()",
        "sdk.AgenticProcess.getById",
        ".prompt(message)",
        ".enqueue(message)",
        "state.process.observeTurn",
        ".loadHistory({ force: true })",
        ".cancelPrompt()",
        "new sdk.ActionInfo('status'",
    )
    for call in expected_calls:
        assert call in source

    assert "new sdk.Chat" not in source
    assert "fetch(" not in source


def test_demo_configures_the_hub_before_loading_the_sdk() -> None:
    source = DEMO.read_text()

    config_position = source.index("window.__FLOWPAD_API_URL__ =")
    sdk_position = source.index('src="../../flow_sdk/server/static/sdk/flowpad-sdk.js"')
    assert config_position < sdk_position


def test_demo_does_not_persist_credentials_or_tokens() -> None:
    source = DEMO.read_text()
    persisted_keys = {
        line.split("localStorage.setItem(", 1)[1].split(",", 1)[0].strip(" '\"")
        for line in source.splitlines()
        if "localStorage.setItem(" in line
    }

    assert persisted_keys == {
        "flowpad-chat.agent",
        "flowpad-chat.hub",
        "flowpad-chat.process",
    }
