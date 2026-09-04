"""Trigger contract for the bundled Flowpad navigation skill."""

import re
from pathlib import Path

import yaml

from flow_sdk.core.dock_address import VIEW_META, PointerRequirement, ViewType


SKILL_PATH = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/flowpad-navigation/SKILL.md"
)


def test_navigation_skill_description_covers_file_followups():
    source = SKILL_PATH.read_text(encoding="utf-8")
    frontmatter = yaml.safe_load(source.split("---", 2)[1])
    description = frontmatter["description"].lower()

    assert "file" in description
    assert "open it" in description


# ── the screen table ───────────────────────────────────────────────────────
#
# The skill used to name NINE of 57 destinations in a prose "More examples:" line,
# with no test on it. That table is now the agent's whole screen vocabulary, so it
# is checked against the catalogue it claims to mirror — otherwise it rots the same
# way, silently, while the suite stays green.

#: `triggers` / `signals` / `cron` decode to the same screen as `events`. The table
#: names the canonical one and folds these into its "also called" column, so an
#: agent is never offered four addresses for one destination.
EVENTS_TWINS = {ViewType.TRIGGERS, ViewType.SIGNALS, ViewType.CRON}


def _table_rows() -> dict[str, tuple[str, set[str]]]:
    """`{address slug: (screen label, aliases)}` parsed out of the skill."""
    source = SKILL_PATH.read_text(encoding="utf-8")
    rows: dict[str, tuple[str, set[str]]] = {}
    for label, address, also in re.findall(
        r"^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|$", source, re.M
    ):
        slug = address.split("/", 1)[0]
        label = re.sub(r"\s*\*\(hub\)\*", "", label).strip()
        aliases = {a.strip() for a in also.split(",") if a.strip() and a.strip() != "—"}
        rows[slug] = (label, aliases)
    return rows


def test_the_table_covers_every_destination():
    """A screen missing from the table is a screen the agent will not find."""
    expected = {
        view.value
        for view, meta in VIEW_META.items()
        if meta.addressable and view not in EVENTS_TWINS
    }
    assert set(_table_rows()) == expected


def test_the_table_never_offers_a_dead_address():
    for slug in _table_rows():
        view = ViewType(slug)
        assert VIEW_META[view].addressable, f"{slug} is not a destination"


def test_the_table_prints_the_catalogue_label_and_aliases():
    """The name is the whole point — a stale label is a wrong screen."""
    for slug, (label, aliases) in _table_rows().items():
        meta = VIEW_META[ViewType(slug)]
        assert label == meta.label, f"{slug}: table says {label!r}, catalogue says {meta.label!r}"
        expected = set(meta.aliases)
        if slug == ViewType.EVENTS.value:
            expected |= {twin.value for twin in EVENTS_TWINS}
        assert aliases == expected, f"{slug}: aliases drifted"


def test_pointer_bearing_screens_are_shown_with_their_pointer():
    """`flow show view helpdesk` is an error; the table must not imply otherwise."""
    source = SKILL_PATH.read_text(encoding="utf-8")
    for view, meta in VIEW_META.items():
        if not meta.addressable or view in EVENTS_TWINS:
            continue
        wanted = f"`{view.value}/<id>`" if meta.pointer is PointerRequirement.REQUIRED else f"`{view.value}`"
        assert wanted in source, f"{view.value} should appear as {wanted}"
