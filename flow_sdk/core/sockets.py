"""Socket-table rules shared by every port check (instance liveness, app ports, dev servers)."""

from __future__ import annotations

import socket


def is_listener(conn) -> bool:
    """A listening socket, as the OS reports it.

    Windows 11 build 26300 after KB5127936 returns some listener rows with state 0
    (psutil: ``NONE``) instead of LISTEN, and others with owner pid 0 — both forms on
    one machine, across calls. A bound local address with no remote end is a listener
    whatever the state says; a stateful connection always has a remote end.
    """
    import psutil

    if not conn.laddr or getattr(conn, "type", socket.SOCK_STREAM) != socket.SOCK_STREAM:
        return False
    return conn.status == psutil.CONN_LISTEN or (conn.status == psutil.CONN_NONE and not conn.raddr)
