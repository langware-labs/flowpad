"""Integration: a real PTY driven PAST the stream-file rolling cap still
replays faithfully.

Drives a real (plain zsh/bash) PTY end-to-end — no mocks, no provider-direct
calls: a Shell is started, a large uniquely-numbered burst is written to its
PTY, the framed output is persisted through the real ``on_pty_output`` →
``PtyStreamFile`` path, and the replay is read back both from the stream file
(the replay artifact) and through ``GET /api/v1/shell/{shell_id}/pty-stream``.

The ``PtyStreamFile`` cap is reduced to a few KB at its creation site (the
``max_size_bytes`` constructor seam, monkeypatched via the module symbol that
``start_machine_pty_session`` imports) so front-truncation fires on a small,
fast burst rather than 10 MB of output. This is a size seam, not a timing one —
the whole burst completes in ~1s.

Invariant under test (pty-layer.md → PtyStreamFile / seq-monotonicity): the
front of the stream is dropped at frame boundaries while the tail — and thus
faithful replay of the most recent screen — survives, the header stays a valid
framed v1 with a real winsize, and output-frame seqs stay monotonic.
"""

import asyncio
import base64
import functools
import uuid

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.compute.providers.desktop import pty_stream_file as psf_module
from flow_sdk.compute.providers.desktop.pty_session_manager import pty_registry
from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile

from tests.api.conftest import default_compute_node_id

# Small cap so a short burst overflows it and front-truncation runs.
_TEST_CAP = 16 * 1024

# 200-byte pad per line → each MARK line is ~215 bytes; 300 lines ≈ 63 KB,
# well past the cap, so the earliest lines are guaranteed dropped.
_PAD = "A" * 200
_N_LINES = 300

# PtyStreamFile with the rolling cap forced small (size seam only). The creation
# site passes ``path``/``cols``/``rows`` and never ``max_size_bytes``, so the
# partial supplies it without conflict.
_CappedStreamFile = functools.partial(PtyStreamFile, max_size_bytes=_TEST_CAP)


def _joined_output(events) -> bytes:
    return b"".join(base64.b64decode(e[1]) for e in events if e[0] == "o")


async def _wait_for_marker(stream_file: PtyStreamFile, marker: bytes, budget: float) -> bool:
    """Poll the stream file until *marker* appears in its output, or budget ends."""
    deadline = asyncio.get_event_loop().time() + budget
    while asyncio.get_event_loop().time() < deadline:
        frames = stream_file.read_frames()
        if frames and marker in _joined_output(frames["events"]):
            return True
        await asyncio.sleep(0.1)
    return False


@pytest.mark.asyncio
async def test_pty_stream_front_truncates_but_replays_tail(
    bootstrapped_client, bootstrap_payload, monkeypatch
):
    # Force the reduced cap at the creation site inside start_machine_pty_session
    # (it does a local ``from ...pty_stream_file import PtyStreamFile`` per call).
    monkeypatch.setattr(psf_module, "PtyStreamFile", _CappedStreamFile)

    client = bootstrapped_client
    cn_id = default_compute_node_id(bootstrap_payload)

    shell = Shell(id=str(uuid.uuid4()), name="trunc-test", compute_node_id=cn_id, status="idle")
    await shell.save()

    try:
        await shell.start()

        # The stream file the real on_pty_output path writes to (the replay
        # artifact). Grab it from the registered session state.
        provider_node_id = shell.compute_node.node_provider_id
        session_state = pty_registry.states[(cn_id, provider_node_id, shell.id)]
        stream_file = session_state.pty_stream_file
        assert stream_file._max_size_bytes == _TEST_CAP, "cap seam not applied"

        pty = shell.compute_node.get_pty(shell.id)
        assert pty is not None

        # Write straight to the PTY handle (no readiness wait): prime with a
        # marker so we know input lands and output is being captured, then fire
        # the burst. A deterministic, self-contained burst: uniquely numbered
        # padded lines followed by a unique sentinel.
        await asyncio.sleep(0.4)  # let the shell reach its prompt
        await pty.write(b"echo __PTY_READY__\r")
        assert await _wait_for_marker(stream_file, b"__PTY_READY__", 8), (  # do not increase timeout without approval
            "shell never echoed the priming marker — input not landing"
        )

        sentinel = f"BURST_SENTINEL_{uuid.uuid4().hex}".encode()
        burst = (
            f"i=0; while [ $i -lt {_N_LINES} ]; do "
            f"printf 'MARK-%05d-{_PAD}\\n' $i; i=$((i+1)); done; "
            f"echo {sentinel.decode()}"
        )
        await pty.write(burst.encode() + b"\r")
        assert await _wait_for_marker(stream_file, sentinel, 8), (  # do not increase timeout without approval
            "sentinel (stream tail) never recorded — burst did not complete"
        )

        # ── Replay artifact: front dropped, tail retained ───────────────────
        frames = stream_file.read_frames()
        assert frames is not None
        joined = _joined_output(frames["events"])
        assert sentinel in joined, "sentinel missing from replay tail"
        assert b"MARK-00000-" not in joined, "front never truncated — earliest line survived"
        assert b"MARK-00299-" in joined, "tail truncated — most recent line lost"
        assert stream_file.size <= _TEST_CAP, "cap not enforced"

        # Header is a valid framed v1 with a real winsize; every retained output
        # frame is intact base64 (no mid-escape cut) and seqs stay monotonic.
        assert frames["v"] == 1
        assert isinstance(frames["cols"], int) and frames["cols"] > 0
        assert isinstance(frames["rows"], int) and frames["rows"] > 0
        last_seq = -1
        for e in frames["events"]:
            if e[0] == "o":
                base64.b64decode(e[1])  # raises if a frame was torn
                if len(e) > 2 and isinstance(e[2], int):
                    assert e[2] >= last_seq, "seq regressed after truncation"
                    last_seq = e[2]

        # ── Same truncated stream is served through the HTTP replay route ────
        r = await client.get(f"/api/v1/shell/{shell.id}/pty-stream")
        assert r.status_code == 200, r.text
        served = r.json()["data"]
        assert served["v"] == 1
        served_out = _joined_output(served["events"])
        assert sentinel in served_out
        assert b"MARK-00000-" not in served_out
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        await shell.delete()
