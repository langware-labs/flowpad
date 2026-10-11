#!/usr/bin/env python3
"""Write the navigation map snapshot into the SmartNavigator dataset, for people browsing it.

    .venv/bin/python scripts/navigation_map.py

``map.json`` is a ``navigation.map`` value -- every screen, what it is called, what its pointer
names and what context it provides. The navigator builds the same value from ``VIEW_META`` at
runtime (``flow_sdk.core.navigation.navigation_map``); this file is only its picture, and
``tests/unit/test_navigation_map.py`` fails when the two drift.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


def main() -> None:
    from flow_sdk.core.navigation import navigation_map
    from flow_sdk.core.navigation import DATASET

    out = DATASET / "map.json"
    out.write_text(json.dumps(navigation_map().model_dump(mode="json"), indent=2) + "\n")
    print(f"wrote {out}")  # noqa: T201 -- a script reports


if __name__ == "__main__":
    main()
