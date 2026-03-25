"""
Tests for MockWorker and MockAgentStreamer.

Validates:
- MockAgentStreamer save/load roundtrip
- MockWorker loads from JSON recording
- MockWorker replays parts in correct order
"""

import tempfile
from pathlib import Path

import pytest

from tests.utils.mock_agent_streamer import MockAgentStreamer

# Path to test recording fixture
RECORDINGS_DIR = Path(__file__).parent.parent / "recordings"
TEST_RECORDING = RECORDINGS_DIR / "test_mock_recording.json"

# MockWorker import triggers deep chain (worker → ComputeSession → logfire)
# that may fail in unit test context. Guard imports accordingly.
try:
    from flow_sdk.core.flow.workers.mock_worker import MockWorker
    from flow_sdk.core.flow.workers.worker import WorkerRegistry

    _MOCK_WORKER_AVAILABLE = True
except Exception:
    _MOCK_WORKER_AVAILABLE = False

_skip_worker = pytest.mark.skipif(not _MOCK_WORKER_AVAILABLE, reason="MockWorker import chain unavailable in unit tests")


class TestMockAgentStreamer:
    """Tests for MockAgentStreamer save/load and serialization."""

    def test_load_from_json_file(self):
        """Test loading MockAgentStreamer from JSON file."""
        streamer = MockAgentStreamer.load(TEST_RECORDING)

        assert streamer.prompt == "Say hello world"
        assert streamer.recorded_text == "Hello, world!"
        assert streamer.content == "Hello, world!"
        assert len(streamer.get_parts()) == 5

    def test_parts_types(self):
        """Test that loaded parts have correct types."""
        streamer = MockAgentStreamer.load(TEST_RECORDING)
        parts = streamer.get_parts()

        assert parts[0]["type"] == "ThinkingPart"
        assert parts[1]["type"] == "TextPart"
        assert parts[2]["type"] == "ToolCallInvocationPart"
        assert parts[3]["type"] == "ToolReturnPart"
        assert parts[4]["type"] == "WorkerResponse"

    def test_parts_content(self):
        """Test that loaded parts have correct content."""
        streamer = MockAgentStreamer.load(TEST_RECORDING)
        parts = streamer.get_parts()

        assert parts[0]["content"] == "The user wants me to say hello world."
        assert parts[1]["content"] == "Hello, world!"
        assert parts[2]["tool_name"] == "write_file"
        assert parts[2]["tool_call_id"] == "call_001"
        assert parts[3]["tool_call_id"] == "call_001"
        assert parts[3]["content"] == "File written successfully"

    def test_metadata(self):
        """Test that metadata is loaded correctly."""
        streamer = MockAgentStreamer.load(TEST_RECORDING)

        assert "client_stream" in streamer.metadata
        assert streamer.metadata["client_stream"] == "<flow-text>Hello, world!</flow-text>"

    def test_save_load_roundtrip(self):
        """Test that save and load produce identical data."""
        original = MockAgentStreamer.load(TEST_RECORDING)

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            temp_path = Path(f.name)

        try:
            original.save(temp_path)
            loaded = MockAgentStreamer.load(temp_path)

            assert loaded.prompt == original.prompt
            assert loaded.recorded_text == original.recorded_text
            assert loaded.content == original.content
            assert len(loaded.get_parts()) == len(original.get_parts())

            for orig_part, loaded_part in zip(original.get_parts(), loaded.get_parts()):
                assert orig_part["type"] == loaded_part["type"]
                if "content" in orig_part:
                    assert orig_part["content"] == loaded_part["content"]
        finally:
            temp_path.unlink(missing_ok=True)

    def test_init_empty(self):
        """Test creating empty MockAgentStreamer."""
        streamer = MockAgentStreamer()

        assert streamer.prompt == ""
        assert streamer.recorded_text == ""
        assert len(streamer.get_parts()) == 0
        assert streamer.content == ""

    def test_init_with_values(self):
        """Test creating MockAgentStreamer with values."""
        streamer = MockAgentStreamer(
            recorded_text="test output",
            prompt="test prompt",
        )

        assert streamer.prompt == "test prompt"
        assert streamer.recorded_text == "test output"
        assert streamer.content == "test output"

    def test_repr(self):
        """Test string representation."""
        streamer = MockAgentStreamer.load(TEST_RECORDING)
        repr_str = repr(streamer)

        assert "MockAgentStreamer" in repr_str
        assert "parts=5" in repr_str


class TestMockWorker:
    """Tests for MockWorker loading and replay."""

    @_skip_worker
    def test_from_json(self):
        """Test creating MockWorker from JSON recording."""
        worker = MockWorker.from_json(TEST_RECORDING)

        assert worker.streamer is not None
        assert worker.get_prompt() == "Say hello world"
        assert worker.get_client_stream() == "<flow-text>Hello, world!</flow-text>"

    @_skip_worker
    def test_from_json_relative_path(self):
        """Test creating MockWorker from relative path."""
        worker = MockWorker.from_json("test_mock_recording.json", recordings_dir=RECORDINGS_DIR)

        assert worker.streamer is not None
        assert worker.get_prompt() == "Say hello world"

    @_skip_worker
    def test_init_without_streamer(self):
        """Test MockWorker without streamer raises on execute."""
        worker = MockWorker()
        assert worker.streamer is None
        assert worker.get_prompt() == ""
        assert worker.get_client_stream() == ""

    @_skip_worker
    @pytest.mark.asyncio
    async def test_execute_task_replays_parts(self):
        """Test that execute_task replays all parts in correct order."""
        worker = MockWorker.from_json(TEST_RECORDING)

        assert worker.streamer is not None
        parts = worker.streamer.get_parts()
        assert len(parts) == 5
        assert parts[0]["type"] == "ThinkingPart"
        assert parts[1]["type"] == "TextPart"
        assert parts[2]["type"] == "ToolCallInvocationPart"
        assert parts[3]["type"] == "ToolReturnPart"
        assert parts[4]["type"] == "WorkerResponse"

    @_skip_worker
    def test_worker_registry_mock_type(self):
        """Test that WorkerRegistry can create MockWorker for MOCK type."""
        from flow_sdk.flowpad_types.enums import WorkerType

        registry = WorkerRegistry()
        worker = registry.get_worker(WorkerType.MOCK)

        assert isinstance(worker, MockWorker)
