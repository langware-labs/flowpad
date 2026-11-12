"""Socket-table rules shared by every port check (instance liveness, app ports, dev servers)."""

from __future__ import annotations

import socket


def is_listener(conn) -> bool:
    """A listening socket, as the OS reports it.

    Windows 11 build 26300.9818 (KB5127936) returns garbage in the state of listener rows —
    the same listening socket reads LISTEN, NONE, CLOSE or FIN_WAIT1 from one call to the
    next — and sometimes no owner pid. So the state is not trusted: a TCP row with a local
    address and no remote end is a listener, because every connection, even a closing one,
    has a remote end.
    """
    if not conn.laddr or getattr(conn, "type", socket.SOCK_STREAM) != socket.SOCK_STREAM:
        return False
    return not conn.raddr
