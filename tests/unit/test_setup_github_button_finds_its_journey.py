"""The "Set up GitHub" button finds its journey on a regular install.

A journey's id lives in its folder's ``.flow/capsules/identity.json`` (``folder_json_identity``),
and the wheel does not ship that capsule — setuptools' ``glob`` skips dot-dirs — so every install
stamps its own uuid4. An id hardcoded in the UI matches only a dev checkout, which carries the
capsule in git; everywhere else the launch is a 404 and the button does nothing. The button names
the journey by its folder instead, and the id is looked up from the journey row.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JOURNEYS = ROOT / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/journey"
BUTTON = ROOT / "ui/src/journey/SetupJourneyButton.tsx"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def test_the_button_names_a_journey_folder_that_ships_and_hardcodes_no_id():
    source = BUTTON.read_text(encoding="utf-8")
    name = re.search(r"SETUP_GITHUB_JOURNEY = '([^']+)'", source).group(1)

    assert (JOURNEYS / name / "graph.json").is_file(), f"no shipped journey folder named {name}"
    assert not UUID.search(source), "a journey id is minted per install; the button must look it up by name"
