"""Stub install: writes the marker serve.py requires."""
import json
import time
from pathlib import Path

marker = Path(__file__).resolve().parent / ".installed" / "marker.json"
marker.parent.mkdir(parents=True, exist_ok=True)
marker.write_text(json.dumps({"installed_at": time.time()}))
print("installed")
