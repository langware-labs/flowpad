"""
Mock Agent Streamer for testing - stores and replays recorded agent parts

Supports:
- Loading/saving recorded parts from JSON
- Replaying parts for mock agent testing
- Text content extraction for validation
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union


class MockAgentStreamer:
    """
    Mock Agent Streamer that stores and replays recorded agent execution parts.

    Purpose:
    - Store recorded parts from real flow execution
    - Replay parts in mock agent for deterministic testing
    - Validate text content matches recorded output
    """

    def __init__(self, parts: Optional[List[Any]] = None, recorded_text: str = "", prompt: str = ""):
        """
        Initialize MockAgentStreamer.

        Args:
            parts: List of recorded parts (optional)
            recorded_text: Full recorded text from deltas (optional)
            prompt: Original prompt that generated this recording (optional)
        """
        self.parts: List[Dict[str, Any]] = []
        self.recorded_text: str = recorded_text
        self.prompt: str = prompt
        self.metadata: Dict[str, Any] = {}

        if parts:
            self._load_parts(parts)

    def _load_parts(self, parts: List[Any]) -> None:
        """Load parts from array of objects."""
        self.parts = []
        for part in parts:
            serialized_part = self._serialize_part(part)
            self.parts.append(serialized_part)

    def _serialize_part(self, part: Any) -> Dict[str, Any]:
        """
        Serialize a part to a dict for storage.

        Extracts only essential data from part objects.
        """
        part_type = type(part).__name__
        serialized: Dict[str, Any] = {
            "type": part_type,
        }

        # Add part_kind if available
        if hasattr(part, "part_kind"):
            serialized["part_kind"] = part.part_kind

        # Serialize content for text-based parts
        if hasattr(part, "content"):
            serialized["content"] = part.content

        # Serialize tool call parts
        if hasattr(part, "tool_name"):
            serialized["tool_name"] = part.tool_name
            if hasattr(part, "args"):
                serialized["args"] = part.args if isinstance(part.args, dict) else {}
            if hasattr(part, "tool_call_id"):
                serialized["tool_call_id"] = part.tool_call_id

        # Serialize tool return parts
        if part_type == "ToolReturnPart":
            if hasattr(part, "tool_call_id"):
                serialized["tool_call_id"] = part.tool_call_id
            if hasattr(part, "content"):
                serialized["content"] = str(part.content)

        # Serialize WorkerResponse
        if part_type == "WorkerResponse":
            serialized["status"] = str(part.status) if hasattr(part, "status") else "COMPLETED"
            serialized["new_messages_count"] = len(part.new_messages) if hasattr(part, "new_messages") else 0
            if hasattr(part, "run_usage"):
                serialized["run_usage"] = {
                    "input_tokens": part.run_usage.input_tokens if hasattr(part.run_usage, "input_tokens") else 0,
                    "output_tokens": part.run_usage.output_tokens if hasattr(part.run_usage, "output_tokens") else 0,
                }

        return serialized

    def save(self, json_path: Union[str, Path]) -> None:
        """
        Save recorded parts to JSON file.

        Args:
            json_path: Path to save JSON file
        """
        json_path = Path(json_path)
        json_path.parent.mkdir(parents=True, exist_ok=True)

        data = {
            "prompt": self.prompt,
            "recorded_text": self.recorded_text,
            "parts": self.parts,
            "metadata": {
                "recorded_at": datetime.now().isoformat(),
                "total_parts": len(self.parts),
                "total_chars": len(self.recorded_text),
                **self.metadata,
            },
        }

        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    @classmethod
    def load(cls, source: Union[str, Path, List[Any]]) -> "MockAgentStreamer":
        """
        Load MockAgentStreamer from JSON file or parts array.

        Args:
            source: Either a path to JSON file or a list of parts

        Returns:
            MockAgentStreamer instance
        """
        if isinstance(source, (str, Path)):
            json_path = Path(source)
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            streamer = cls()
            streamer.prompt = data.get("prompt", "")
            streamer.recorded_text = data.get("recorded_text", "")
            streamer.parts = data.get("parts", [])
            streamer.metadata = data.get("metadata", {})
            return streamer
        else:
            return cls(parts=source)

    @property
    def content(self) -> str:
        """
        Get the full text content for comparison.

        Returns the recorded_text which contains all streamed deltas.
        """
        return self.recorded_text

    def get_parts(self) -> List[Dict[str, Any]]:
        """Get the list of serialized parts."""
        return self.parts

    def __repr__(self) -> str:
        return f"MockAgentStreamer(parts={len(self.parts)}, chars={len(self.recorded_text)})"
