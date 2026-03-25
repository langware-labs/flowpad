"""
Shared state for the local server.
"""

import threading
from typing import Dict, Any

from .reporters import BufferReporter, WebSocketReporter, ReporterRegistry


# Shared state for login
login_result = None
login_received = threading.Event()

# Shared state for ping
ping_results = []
ping_received = threading.Event()

# Shared state for prompts
prompt_results = []
prompt_received = threading.Event()

# Background Claude sessions
claude_sessions: Dict[str, Dict[str, Any]] = {}
session_counter = 0
session_lock = threading.Lock()

# Hook reporters
buffer_reporter = BufferReporter(max_size=100)
ws_reporter = WebSocketReporter()

# Reporter registry - manages active reporters
reporter_registry = ReporterRegistry()
reporter_registry.add(buffer_reporter)
reporter_registry.add(ws_reporter)
