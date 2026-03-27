"""Tests for run_process_domain()."""

from unittest.mock import patch, MagicMock

from flow_sdk.builtin.process_runner import ProcessConfig, run_process_domain
from flow_sdk.builtin.agentic_process import AgenticProcess


class TestRunProcessDomain:
    def test_run_process_domain_returns_domain_object(self, tmp_path):
        config = ProcessConfig(
            skill_name="test_skill",
            instruction="do something",
            workdir=str(tmp_path),
        )
        mock_proc = MagicMock()
        with patch("flow_sdk.builtin.process_runner.subprocess.Popen", return_value=mock_proc):
            result, proc = run_process_domain(config, workdir=str(tmp_path))

        assert isinstance(result, AgenticProcess)
        assert result.name.startswith("test_skill:")
        assert proc is mock_proc
