"""Tests for ProcessMonitor."""

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from flow_sdk.domain.process_monitor import ProcessMonitor
from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord, ProcessorStatus


class TestProcessMonitor:
    @pytest.mark.asyncio
    async def test_watch_yields_status_change(self, tmp_path: Path):
        records_dir = tmp_path / ".flow_records"
        records_dir.mkdir()

        record_data = {
            "id": "proc-1",
            "type": "agentic_process",
            "name": "test",
            "state": "running",
        }
        record_file = records_dir / "proc-1.json"
        record_file.write_text(json.dumps(record_data), encoding="utf-8")

        monitor = ProcessMonitor(tmp_path)
        call_count = 0

        def mock_discover(self, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count <= 1:
                return ProcessorStatus.RUNNING
            return ProcessorStatus.COMPLETE

        events = []
        with patch.object(AgenticProcessRecord, "discover_status", mock_discover):
            async for event in monitor.watch(poll_interval=0.01):
                events.append(event)

        assert len(events) == 1
        assert events[0]["status"] == "complete"
        assert events[0]["previous"] == "running"
        assert events[0]["agentic_process_id"] == "proc-1"

    @pytest.mark.asyncio
    async def test_watch_empty_dir(self, tmp_path: Path):
        records_dir = tmp_path / ".flow_records"
        records_dir.mkdir()

        monitor = ProcessMonitor(tmp_path)
        events = []

        async def collect():
            async for event in monitor.watch(poll_interval=0.01):
                events.append(event)

        # Empty dir has no records, generator never yields or terminates.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(collect(), timeout=0.1)

        assert events == []

    @pytest.mark.asyncio
    async def test_watch_terminates_on_all_complete(self, tmp_path: Path):
        records_dir = tmp_path / ".flow_records"
        records_dir.mkdir()

        for i in range(2):
            record_data = {
                "id": f"proc-{i}",
                "type": "agentic_process",
                "name": f"test-{i}",
                "state": "running",
            }
            (records_dir / f"proc-{i}.json").write_text(json.dumps(record_data), encoding="utf-8")

        monitor = ProcessMonitor(tmp_path)
        call_count = 0

        def mock_discover(self, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            # First pass (2 records): return RUNNING for both -> seed cache
            # Second pass: return COMPLETE for both -> yield events + terminate
            if call_count <= 2:
                return ProcessorStatus.RUNNING
            return ProcessorStatus.COMPLETE

        events = []
        with patch.object(AgenticProcessRecord, "discover_status", mock_discover):
            async for event in monitor.watch(poll_interval=0.01):
                events.append(event)

        assert len(events) == 2
        assert all(e["status"] == "complete" for e in events)
