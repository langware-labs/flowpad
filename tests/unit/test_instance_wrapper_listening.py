"""A role launched through a wrapper (`uv run`) is listening when its own child serves the port.

The launcher records the wrapper's pid; the Python child binds the socket. Requiring the
recorded process itself to listen made every `uv run` launch read "not listening", so the
live-instance resolver refused a healthy, launcher-owned backend.
"""

from flow_sdk.instances import manager
from flow_sdk.instances.liveness import ProcInfo, ProcTable
from flow_sdk.instances.model import LauncherRecord, ProcRef, Role, Tier

PORT = 6005


def _proc(pid, ppid, *, instance="oast-5", ports=()):
    return ProcInfo(
        pid=pid,
        ppid=ppid,
        create_time=1.0,
        name="python",
        cmdline=("python",),
        instance=instance,
        tier=Tier.LINEAGE,
        role=Role.BACKEND,
        listen_ports=frozenset(ports),
    )


def _backend_status(*procs):
    table = ProcTable(
        procs={proc.pid: proc for proc in procs},
        port_index={PORT: [proc.pid for proc in procs if PORT in proc.listen_ports]},
    )
    record = LauncherRecord(name="oast-5", group="oast-5", backend=ProcRef(pid=100, port=PORT))
    return manager._role_status("oast-5", record, Role.BACKEND, table)


def test_a_wrapper_whose_child_serves_the_port_is_listening():
    status = _backend_status(_proc(100, 1), _proc(101, 100, ports=(PORT,)))

    assert status.owned and status.listening


def test_another_instance_on_the_port_does_not_make_the_wrapper_listening():
    status = _backend_status(_proc(100, 1), _proc(200, 1, instance="prod", ports=(PORT,)))

    assert status.owned and not status.listening
