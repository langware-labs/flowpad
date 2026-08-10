"""Fast unit tests for the backend AgenticProcess spawn sites.

Covers:
  - scan_actions.py  ``createProcess``  (_scan_create_process, fresh)
  - scan_actions.py  ``upsertSessionProcess`` (_scan_upsert_session_process, resume)

We mock get_current_request_info, AgenticProcess.save, and AgenticProcess.start
so the tests run in milliseconds without a DB or real PTY. The goal is to
validate post-`asset_ref` refactor constructor args (no `source_vfs_path`,
correct field names) and that the action returns a success response.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_compute_node() -> ComputeNode:
    # Real instance so the action's exception/log paths can read self.id without
    # triggering pydantic AttributeError (which would mask the real failure).
    return ComputeNode()


def _make_request_info(body: dict):
    info = MagicMock()
    info.someone_typeid = None
    info.request = MagicMock()
    info.get_post_data = AsyncMock(return_value=body)
    return info


_PATCH_REQ_SCAN = "flow_sdk.builtin.faas.scan_actions.get_current_request_info"


class _InstalledHarness:
    """Base for the ``AgenticProcess`` stand-ins below.

    ``_scan_create_process`` now refuses before persisting anything when the
    chosen harness isn't installed, and it asks the class itself
    (``AgenticProcess.is_installed``). Every fake that replaces AgenticProcess
    must therefore answer that call, or the pre-flight would refuse first and
    the case under test would never run.
    """

    @staticmethod
    async def is_installed(worker_type=None) -> bool:
        return True


# ─── createProcess fresh path ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_scan_create_process_fresh_path_constructs_with_post_refactor_fields():
    """_scan_create_process must construct AgenticProcess with the field set
    declared at scan_actions.py:318-328 — and never source_vfs_path."""
    node = _make_compute_node()
    info = _make_request_info({
        "context": {
            "workdir": "/tmp/proj",
            "permission_mode": "bypassPermissions",
            "model": "md",
            "worker_type": "claude_code",
        },
        "visible": True,
    })

    captured: dict = {}

    class FakeProc(_InstalledHarness):
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self._data = kwargs
            self.id = "fresh-1"
            self.type = "agentic_process"
            self.shell_id = None

        async def save(self, owner=None):
            captured["__saved_owner"] = owner

        async def start_pty(self, visible=False, **kwargs):
            captured["__started_visible"] = visible
            return ApiSuccessResponse(data={"id": self.id})

        def model_dump(self, mode=None):
            return {"id": self.id, "type": self.type, "shell_id": self.shell_id, **self._data}

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_create_process()

    assert resp.status == "SUCCESS", resp.message if hasattr(resp, "message") else resp
    assert resp.data["id"] == "fresh-1"
    # Validate post-refactor field set
    expected = {
        "worker_type", "instruction_content", "cli_config", "context_data",
        "workdir", "visible", "additional_dirs", "project_id", "target_typeid_str",
    }
    assert expected.issubset(captured.keys()), captured.keys()
    assert captured["workdir"] == "/tmp/proj"
    assert captured["visible"] is True
    assert captured["cli_config"]["model"] == "md"
    assert "source_vfs_path" not in captured
    # Visible processes must be eagerly started so the terminal tab strip
    # gets a fully-attached row in one round-trip.
    assert captured.get("__started_visible") is True


@pytest.mark.asyncio
async def test_scan_create_process_headless_does_not_eagerly_start():
    """Headless (visible=False) processes manage their lifecycle per-turn via
    ``headless_prompt``. Eagerly calling ``start()`` here pre-allocates a
    session_id without ever writing a JSONL, which then makes the next
    ``/prompt`` land on a stale session and emit no assistant turn."""
    node = _make_compute_node()
    info = _make_request_info({
        "context": {"workdir": "/tmp/proj", "worker_type": "claude_code"},
        "visible": False,
    })

    captured: dict = {}

    class FakeProc(_InstalledHarness):
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self._data = kwargs
            self.id = "headless-1"
            self.type = "agentic_process"
            self.shell_id = None

        async def save(self, owner=None):
            captured["__saved_owner"] = owner

        async def start_pty(self, visible=False, **kwargs):
            captured["__started_visible"] = visible
            return ApiSuccessResponse(data={"id": self.id})

        def model_dump(self, mode=None):
            return {"id": self.id, "type": self.type, "shell_id": self.shell_id, **self._data}

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_create_process()

    assert resp.status == "SUCCESS"
    assert resp.data["id"] == "headless-1"
    assert captured["visible"] is False
    # Critical: start_pty() must NOT be called for headless processes.
    assert "__started_visible" not in captured


# ─── createProcess harness pre-flight (FLOWPAD-1971) ─────────────────────────


class _NeverBuilt(_InstalledHarness):
    """An AgenticProcess stand-in that fails the test if it is constructed."""

    def __init__(self, **kwargs):
        raise AssertionError(f"AgenticProcess must not be constructed: {kwargs}")


class _MissingHarness(_NeverBuilt):
    """...and whose CLI discovery never found, so the pre-flight must refuse."""

    @staticmethod
    async def is_installed(worker_type=None) -> bool:
        return False


@pytest.mark.asyncio
@pytest.mark.parametrize("visible", [True, False])
async def test_scan_create_process_missing_harness_is_400_not_500(visible):
    """A harness the machine can't run is a client error, and nothing is created.

    Before this, the miss surfaced deep in ``_perform_open`` as a RuntimeError
    that became an ``ApiFailResponse`` with no ``status_code`` — which defaults to
    500 — after the row had already been saved and latched FAILED. Both modes are
    covered: headless used to be born fine and only break on its first prompt.
    """
    from flow_sdk.builtin.agentic_process.launch_health import LaunchErrorCode

    node = _make_compute_node()
    info = _make_request_info({
        "context": {"workdir": "/tmp/proj", "worker_type": "codex"},
        "visible": visible,
    })

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", _MissingHarness):
        resp = await node._scan_create_process()

    assert isinstance(resp, ApiFailResponse)
    assert resp.status_code == 400, "a missing harness must not read as a server fault"
    # The machine-readable half — what the UI branches on and deep-links with.
    assert resp.data["code"] == LaunchErrorCode.NOT_INSTALLED.value
    assert resp.data["capability_kind"] == "harness.codex.cli"
    assert resp.data["worker_type"] == "codex"
    assert resp.data["health"] == "config_error"
    # The human half must name the provider, not restate the status line.
    assert "not installed" in (resp.message or "")


@pytest.mark.asyncio
async def test_scan_create_process_preflight_never_probes_login():
    """The gate must not pay for an auth probe on the create path.

    ``is_installed`` is a lookup in the discovery dict. Its neighbour
    ``is_logged_in`` shells out to the vendor CLI, uncached, per call — which is
    why the pre-flight calls the former directly rather than going through
    ``ensure_launchable``, which runs both.
    """
    node = _make_compute_node()
    info = _make_request_info({
        "context": {"workdir": "/tmp/proj", "worker_type": "codex"},
        "visible": False,
    })

    class FakeProc(_InstalledHarness):
        is_installed = AsyncMock(return_value=True)
        is_logged_in = AsyncMock()

        def __init__(self, **kwargs):
            self.id = "preflight-1"
            self.type = "agentic_process"
            self.shell_id = None
            self._data = kwargs

        async def save(self, owner=None):
            return None

        def model_dump(self, mode=None):
            return {"id": self.id, "type": self.type, "shell_id": self.shell_id, **self._data}

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_create_process()

    assert resp.status == "SUCCESS"
    FakeProc.is_installed.assert_awaited_once_with("codex")
    FakeProc.is_logged_in.assert_not_awaited()


@pytest.mark.asyncio
async def test_scan_create_process_unknown_worker_type_is_400():
    """An unrecognised worker_type is unambiguously the caller's mistake; it
    answered 500 purely because ``ApiFailResponse.status_code`` defaults there."""
    node = _make_compute_node()
    info = _make_request_info({"context": {"worker_type": "not_a_worker"}, "visible": False})

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", _NeverBuilt):
        resp = await node._scan_create_process()

    assert isinstance(resp, ApiFailResponse)
    assert resp.status_code == 400
    assert "not_a_worker" in (resp.message or "")


@pytest.mark.asyncio
async def test_scan_create_process_start_race_classifies_to_400():
    """The pre-flight can lose a race — a CLI deleted between check and spawn.

    ``_perform_open`` returns that as an ``ApiFailResponse`` with no status_code.
    Classifying the latched reason keeps it a client error rather than a 500.
    """
    node = _make_compute_node()
    info = _make_request_info({
        "context": {"workdir": "/tmp/proj", "worker_type": "codex"},
        "visible": True,
    })

    class FakeProc(_InstalledHarness):
        def __init__(self, **kwargs):
            self.id = "raced-1"
            self.type = "agentic_process"
            self.shell_id = None
            self._data = kwargs

        async def save(self, owner=None):
            return None

        async def start_pty(self, visible=False, **kwargs):
            raise RuntimeError(
                "Command not found: 'codex' — no harness.codex.cli installation discovered"
            )

        def model_dump(self, mode=None):
            return {"id": self.id, "type": self.type, "shell_id": self.shell_id, **self._data}

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_create_process()

    assert isinstance(resp, ApiFailResponse)
    assert resp.status_code == 400
    assert resp.data["code"] == "not_installed"
    assert resp.data["capability_kind"] == "harness.codex.cli"


@pytest.mark.asyncio
async def test_scan_create_process_uses_capability_default_without_overriding_explicit_worker():
    node = _make_compute_node()
    captured: list[dict] = []

    class FakeProc(_InstalledHarness):
        def __init__(self, **kwargs):
            captured.append(kwargs)
            self._data = kwargs
            self.id = f"proc-{len(captured)}"
            self.type = "agentic_process"
            self.shell_id = None

        async def save(self, owner=None):
            return None

        def model_dump(self, mode=None):
            return {"id": self.id, "type": self.type, "shell_id": self.shell_id, **self._data}

    default_info = _make_request_info({
        "context": {"workdir": "/tmp/proj", "env_vars": {"FLOWPAD_TEST_MARKER": "1"}},
        "visible": False,
    })
    explicit_info = _make_request_info({
        "context": {"workdir": "/tmp/proj", "worker_type": "claude_code"},
        "visible": False,
    })

    with patch(
        "flow_sdk.core.capabilities.registry.resolve_default_worker_type",
        AsyncMock(return_value="codex"),
    ), patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        with patch(_PATCH_REQ_SCAN, return_value=default_info):
            assert (await node._scan_create_process()).status == "SUCCESS"
        with patch(_PATCH_REQ_SCAN, return_value=explicit_info):
            assert (await node._scan_create_process()).status == "SUCCESS"

    assert captured[0]["worker_type"] == "codex"
    assert captured[0]["cli_config"]["worker_type"] == "codex"
    assert captured[0]["cli_config"]["env_vars"]["FLOWPAD_TEST_MARKER"] == "1"
    assert captured[1]["worker_type"] == "claude_code"
    assert captured[1]["cli_config"]["worker_type"] == "claude"


# ─── upsertSessionProcess resume path ────────────────────────────────────────


@pytest.mark.asyncio
async def test_scan_upsert_session_process_creates_fresh_when_no_existing():
    """When no existing AgenticProcess matches session_id, a new one is built
    with session_id, use_worker_history=True, context_data, project_id —
    no source_vfs_path."""
    node = _make_compute_node()
    info = _make_request_info({
        "sessionId": "sess-new-1",
        "workdir": "/tmp/wd",
    })

    captured: dict = {}

    class FakeProc(_InstalledHarness):
        # get_all returns [] (no existing), so fall through to construct branch
        @classmethod
        async def get_by_session_id(cls, session_id):
            # No existing process for this session → construct branch.
            return None

        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.id = "new-2"
            self.type = "agentic_process"
            self.session_id = kwargs.get("session_id")
            self.cli_config = kwargs.get("cli_config", {}) or {}
            self.workdir = kwargs.get("workdir")
            self.shell_id = None
            self.visible = kwargs.get("visible", False)
            self.worker_type = kwargs.get("worker_type")

        async def save(self, owner=None):
            captured["__saved_owner"] = owner

        async def start_pty(self, visible=False, **kwargs):
            captured["__started_visible"] = visible
            return ApiSuccessResponse(data={"id": self.id})

        def model_dump(self, mode=None):
            return {
                "id": self.id,
                "type": self.type,
                "session_id": self.session_id,
                "cli_config": self.cli_config,
                "workdir": self.workdir,
                "shell_id": self.shell_id,
                "visible": self.visible,
                "worker_type": self.worker_type,
            }

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_upsert_session_process()

    assert resp.status == "SUCCESS", resp
    # Production returns ``process.model_dump(mode="json")`` directly — there's
    # no ``created`` flag injection in the response (AgenticProcess has no such
    # field). The fresh-vs-resume distinction is verified via captured kwargs.
    assert resp.data["session_id"] == "sess-new-1"
    assert captured["session_id"] == "sess-new-1"
    assert captured["use_worker_history"] is True
    assert "context_data" in captured
    assert "source_vfs_path" not in captured


@pytest.mark.asyncio
async def test_scan_upsert_session_process_returns_existing_on_resume():
    """When an AgenticProcess with the same session_id already exists, return it
    without constructing a new one."""
    node = _make_compute_node()
    info = _make_request_info({"sessionId": "sess-existing"})

    existing = MagicMock()
    existing.id = "existing-id"
    existing.type = "agentic_process"
    existing.session_id = "sess-existing"
    existing.shell_id = "shell-1"
    existing.visible = True
    existing.worker_type = "claude"
    existing.pty_pid = None
    # ``_scan_upsert_session_process`` returns ``process.model_dump(mode="json")``
    # to the caller; configure the mock to produce a real dict so the response
    # has ``data["id"] == "existing-id"`` instead of a recursive MagicMock.
    existing.model_dump.return_value = {
        "id": "existing-id",
        "type": "agentic_process",
        "session_id": "sess-existing",
        "shell_id": "shell-1",
        "visible": True,
        "worker_type": "claude",
        "pty_pid": None,
        "created": False,
    }

    class FakeProc(_InstalledHarness):
        constructed = False

        @classmethod
        async def get_by_session_id(cls, session_id):
            return existing

        def __init__(self, **kwargs):
            FakeProc.constructed = True

    with patch(_PATCH_REQ_SCAN, return_value=info), \
         patch("flow_sdk.builtin.agentic_process.AgenticProcess", FakeProc):
        resp = await node._scan_upsert_session_process()

    assert resp.status == "SUCCESS"
    assert resp.data["id"] == "existing-id"
    assert resp.data["type"] == "agentic_process"
    assert resp.data["session_id"] == "sess-existing"
    # Production returns ``process.model_dump(mode="json")`` directly; no
    # ``created`` flag is injected. The "no new construction" property is
    # verified via FakeProc.constructed below.
    assert FakeProc.constructed is False, "Should not construct a new entity on resume hit"
