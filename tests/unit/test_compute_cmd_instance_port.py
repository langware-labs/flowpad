from flow_sdk.cli.commands import compute_cmd


def test_docker_worker_callback_uses_instance_aware_cli_discovery(monkeypatch):
    monkeypatch.setattr(compute_cmd, "_discover_port", lambda: 6123)

    assert compute_cmd._outer_ws_url() == (
        "ws://host.docker.internal:6123/api/v1/compute/ws"
    )
