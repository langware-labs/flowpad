"""End-to-end test: the asset_cleanup agent identifies planted garbage assets.

Steps:
  1. Plant a fixture root with obvious junk (a placeholder skill + agent) and
     obvious keepers (a substantive skill + agent) under ``<root>/.claude/``.
  2. Call ``run_asset_cleanup(roots=[root])`` — loads the system
     ``asset_cleanup`` agent md and runs it as a one-shot headless
     AgenticProcess on haiku (the model the agent frontmatter declares).
  3. Assert the parsed report flags the junk as garbage, does not flag the
     keepers as garbage, and that the worker actually ran on haiku.

Requires:
  - DEEP_TESTING=true  (or 1 / yes)
  - `claude` CLI in PATH and network access (module is in the
    ``_REAL_HOME_TEST_MODULES`` allowlist so the CLI subprocess sees real
    ``$HOME`` credentials).
"""

from pathlib import Path

import pytest

from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
]

from flow_sdk.asset_cleanup import generate_asset_cleanup_report, run_asset_cleanup

JUNK_SKILL = "test_skill"
JUNK_AGENT = "probe-agent"
GOOD_SKILL = "release-notes"
GOOD_AGENT = "db-migrator"


def _plant_fixture(root: Path) -> None:
    skills = root / ".claude" / "skills"
    agents = root / ".claude" / "agents"
    (skills / JUNK_SKILL).mkdir(parents=True)
    (skills / JUNK_SKILL / "SKILL.md").write_text(
        "---\nname: test_skill\ndescription: Skill\n---\n\ntest\n"
    )
    (skills / GOOD_SKILL).mkdir(parents=True)
    (skills / GOOD_SKILL / "SKILL.md").write_text(
        "---\nname: release-notes\ndescription: Draft release notes from the "
        "merged PRs since the last tag.\n---\n\n# Release notes\n\n"
        "1. Run `git log --oneline <last-tag>..HEAD` to list merged changes.\n"
        "2. Group entries by area (backend, ui, sdk) and rewrite each as a "
        "user-facing sentence.\n"
        "3. Flag breaking changes in a dedicated section with upgrade steps.\n"
        "4. Output a markdown document with sections Features, Fixes, Breaking.\n"
    )
    agents.mkdir(parents=True)
    (agents / f"{JUNK_AGENT}.md").write_text(
        "---\nname: probe-agent\ndescription: probe\n---\n\nprobe\n"
    )
    (agents / f"{GOOD_AGENT}.md").write_text(
        "---\nname: db-migrator\ndescription: Plans and applies schema "
        "migrations safely with reversible steps.\n"
        "tools: Bash, Read, Edit\n---\n\n# DB migrator\n\n"
        "You design database schema migrations. Always produce an up and a "
        "down migration, verify the down restores the previous schema, and "
        "run the project's migration tests before declaring success. Never "
        "drop a column without an explicit deprecation window.\n"
    )


@pytest.mark.asyncio
# 60s LLM-test exception (DEEP_TESTING, approved) — do not increase.
@pytest.mark.timeout(60)
async def test_asset_cleanup_agent_flags_planted_garbage(tmp_path):
    _plant_fixture(tmp_path)

    result = await run_asset_cleanup(roots=[tmp_path], workdir=str(tmp_path))

    by_name = {f.name: f for f in result.findings}
    assert set(by_name) >= {JUNK_SKILL, JUNK_AGENT, GOOD_SKILL, GOOD_AGENT}, (
        f"expected all four planted assets inventoried, got {sorted(by_name)}\n"
        f"raw:\n{result.raw_text}"
    )

    assert by_name[JUNK_SKILL].verdict == "garbage", by_name[JUNK_SKILL]
    assert by_name[JUNK_AGENT].verdict == "garbage", by_name[JUNK_AGENT]
    # Keepers must not be flagged for deletion (keep or unsure both fine).
    assert by_name[GOOD_SKILL].verdict != "garbage", by_name[GOOD_SKILL]
    assert by_name[GOOD_AGENT].verdict != "garbage", by_name[GOOD_AGENT]

    assert any("haiku" in m.lower() for m in result.models_used), (
        f"expected a haiku worker, models_used={result.models_used}"
    )

    # Full chain: persist the report + gated feed entry (garbage was found).
    from flow_sdk.builtin.feed_entry import FeedEntry
    from flow_sdk.schema.type_info import register_all

    register_all()  # default_body_fn wiring — server import does this, pytest doesn't
    report = await generate_asset_cleanup_report(result)
    assert report.garbage_count >= 2
    entries = [
        e for e in await FeedEntry.get_all()
        if isinstance(e.data, dict) and e.data.get("type_id") == str(report.typeid)
    ]
    assert len(entries) == 1, "garbage found → feed entry posted"
