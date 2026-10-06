"""The server's event loop on Windows: a Proactor loop that survives a client hanging up.

asyncio's Proactor ``_start_serving`` (CPython 3.11–3.14, ``proactor_events.py``)
closes the LISTENING socket on any ``OSError`` from ``accept()``. On Windows a peer
that connects and drops before the accept completes surfaces as exactly that —
``WinError 64`` (ERROR_NETNAME_DELETED) — so one impatient client (a browser that
gave up, a timed-out ``curl``, a port forward resetting) stops the backend from ever
accepting again: the process lives, the port is dead, even ``127.0.0.1`` is refused.

This loop keeps the stdlib's serve loop and changes one decision: a failed accept
that is only the peer having gone away re-arms the accept and keeps serving. Any
other failure — and every close — behaves exactly as the stdlib does.
"""

from __future__ import annotations

import sys

# The Windows error codes (and their socket twins) for "the client went away before
# the accept finished" — the one accept failure that says nothing about the listener.
_PEER_GONE_WINERRORS = frozenset(
    {
        64,  # ERROR_NETNAME_DELETED
        1236,  # ERROR_CONNECTION_ABORTED
        10053,  # WSAECONNABORTED
        10054,  # WSAECONNRESET
    }
)


def _peer_gone(exc: OSError) -> bool:
    return isinstance(exc, (ConnectionResetError, ConnectionAbortedError)) or (
        getattr(exc, "winerror", None) in _PEER_GONE_WINERRORS
    )


if sys.platform == "win32":  # pragma: no cover - exercised on Windows only
    import asyncio
    from asyncio import exceptions, trsock
    from asyncio.log import logger

    class ResilientProactorEventLoop(asyncio.ProactorEventLoop):
        """``ProactorEventLoop`` whose listeners outlive a client hanging up mid-accept."""

        def _start_serving(
            self,
            protocol_factory,
            sock,
            sslcontext=None,
            server=None,
            backlog=100,
            ssl_handshake_timeout=None,
            ssl_shutdown_timeout=None,
        ):
            # The stdlib serve loop (proactor_events.BaseProactorEventLoop._start_serving),
            # with the peer-gone accept failure re-armed instead of closing ``sock``.
            def loop(f=None):
                try:
                    if f is not None:
                        conn, addr = f.result()
                        if self._debug:
                            logger.debug("%r got a new connection from %r: %r", server, addr, conn)
                        protocol = protocol_factory()
                        if sslcontext is not None:
                            self._make_ssl_transport(
                                conn,
                                protocol,
                                sslcontext,
                                server_side=True,
                                extra={"peername": addr},
                                server=server,
                                ssl_handshake_timeout=ssl_handshake_timeout,
                                ssl_shutdown_timeout=ssl_shutdown_timeout,
                            )
                        else:
                            self._make_socket_transport(conn, protocol, extra={"peername": addr}, server=server)
                    if self.is_closed():
                        return
                    f = self._proactor.accept(sock)
                except OSError as exc:
                    if sock.fileno() != -1 and _peer_gone(exc) and not self.is_closed():
                        # Only this client went away; the listener is fine. Keep serving.
                        logger.debug("Accept: peer gone before accept completed (%s); re-arming", exc)
                        self.call_soon(loop)
                    elif sock.fileno() != -1:
                        self.call_exception_handler(
                            {
                                "message": "Accept failed on a socket",
                                "exception": exc,
                                "socket": trsock.TransportSocket(sock),
                            }
                        )
                        sock.close()
                    elif self._debug:
                        logger.debug("Accept failed on socket %r", sock, exc_info=True)
                except exceptions.CancelledError:
                    sock.close()
                else:
                    self._accept_futures[sock.fileno()] = f
                    f.add_done_callback(loop)

            self.call_soon(loop)
