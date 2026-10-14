"""The audience doors' port numbers — pinned, because the hub addresses them blind."""

from flow_sdk.instance_settings.base_settings import AUDIENCE_PORTS, DEFAULT_PROD_PORT, audience_ports
from flow_sdk.instance_settings.dev_settings import DEFAULT_DEV_PORT
from flow_sdk.instance_settings.test_settings import DEFAULT_TEST_PORT
from flow_sdk.schema.data_spec.service_endpoint_spec import WEB_AUDIENCES


def test_every_web_audience_has_a_door_and_the_hub_knows_the_number():
    """Same literal as ``flowpad.config.AUDIENCE_PORTS`` on the hub — change both or neither."""
    assert tuple(AUDIENCE_PORTS) == WEB_AUDIENCES
    assert AUDIENCE_PORTS == {"admin": 9017, "app": 9027}


def test_the_doors_do_not_collide_with_an_instance_port():
    taken = {DEFAULT_PROD_PORT, DEFAULT_DEV_PORT, DEFAULT_TEST_PORT}
    assert not taken & set(AUDIENCE_PORTS.values())


def test_an_instance_may_move_a_door_for_a_shared_host(monkeypatch):
    """Several instances on one desktop cannot share 9017; a box runs one and keeps the default."""
    assert audience_ports() == AUDIENCE_PORTS
    monkeypatch.setenv("AUDIENCE_PORT_APP", "9127")
    monkeypatch.setenv("AUDIENCE_PORT_ADMIN", "not-a-port")
    assert audience_ports() == {"admin": 9017, "app": 9127}
