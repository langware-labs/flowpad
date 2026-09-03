"""No migration recipe may be stranded — unreachable by every install forever.

``run_if_needed`` resolves a recipe under the RUNNING version's own directory
(``runner._resolve_recipe(__version__)``) and silently returns 0 when there is
none. So a recipe committed after its version was built is not merely late: no
install will ever be that version again, and every later release looks under
its own directory instead. That is what emptied
``<flow_home>/global/migrations`` on a machine upgrading for months — recipe
after recipe was written the day AFTER the release it was named for.

Two ways to satisfy the rule, and this test accepts either:

* the recipe was in the tree at the commit that set ``__version__`` to its own
  version — it shipped in its own wheel and ran; or
* it is re-driven by an UNRELEASED recipe, which names it in ``STRANDED``.

The first is how a new migration should be written (put it under the next
unreleased version). The second is how already-stranded history is repaid.
"""
from __future__ import annotations

import os
import subprocess
import tarfile
from pathlib import Path

import pytest

from flow_sdk.migrations.runner import _resolve_recipe, load_script_module

REPO = Path(__file__).resolve().parents[2]
MIGRATIONS = Path("flow_sdk/system_projects/flowpad_assistant/migrations")
VERSION_FILE = Path("flow_sdk/_version.py")


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout


def _release_commit(version: str) -> str | None:
    """The commit that introduced ``__version__ = "<version>"`` — the tree the
    wheel for that version was built from. ``-S`` matches both the bump-to and
    the later bump-away, so the OLDEST hit is the release."""
    out = _git(
        "log", "--format=%H", "-S", f'__version__ = "{version}"', "--", str(VERSION_FILE)
    ).split()
    return out[-1] if out else None


def _migrations_root_at(commit: str, tmp: Path) -> Path:
    """Materialize the migrations directory as it stood at ``commit``."""
    root = tmp / commit[:9]
    root.mkdir(parents=True, exist_ok=True)
    archive = tmp / f"{commit[:9]}.tar"
    with archive.open("wb") as fh:
        subprocess.run(
            ["git", "archive", "--format=tar", commit, str(MIGRATIONS)],
            cwd=REPO, stdout=fh, stderr=subprocess.DEVNULL, check=False,
        )
    if archive.stat().st_size:
        with tarfile.open(archive) as tf:
            tf.extractall(root)  # noqa: S202 — our own git history
    # An absent directory is a legitimate answer, not an error: it is exactly
    # the "never shipped" case.
    return root / MIGRATIONS


def _recipe_versions() -> list[str]:
    return sorted(p.name for p in (REPO / MIGRATIONS).iterdir() if p.is_dir())


def _shipped_in_own_wheel(version: str, commit: str, tmp: Path) -> bool:
    """Ask the REAL resolver — the one ``run_if_needed`` calls — whether the
    wheel for ``version`` would have found its own recipe."""
    os.environ["FLOWPAD_MIGRATIONS_ROOT"] = str(_migrations_root_at(commit, tmp))
    try:
        return _resolve_recipe(version) is not None
    finally:
        os.environ.pop("FLOWPAD_MIGRATIONS_ROOT", None)


def _catch_up_coverage(never_shipped: dict[str, str]) -> set[str]:
    """Versions re-driven by a recipe that will actually run. A catch-up recipe
    declares them in a module-level ``STRANDED`` tuple; one without it covers
    nothing.

    The disqualifier is being STRANDED, not being released. A recipe that
    shipped in its own wheel runs on every install of that version, so it CAN
    repay debt — and it is the normal place to do so, because the release that
    carries a repayment is cut right after it lands. Excluding every released
    version instead made the repayment stop counting the moment its own version
    was bumped: 0.2.153's recipe declared the six stranded versions, the bump
    commit followed minutes later, and this guard then reported that nothing
    covered them. Only a recipe that never shipped is disqualified — it will
    never run, so it can repay nothing, including itself.
    """
    covered: set[str] = set()
    for version in _recipe_versions():
        if version in never_shipped:
            continue  # stranded itself — it never runs, so it covers nothing
        script = REPO / MIGRATIONS / version / "scripts" / "migrate.py"
        if not script.is_file():
            continue
        name = f"_catchup_probe_{version.replace('.', '_')}"
        with load_script_module(name, script) as module:
            covered.update(getattr(module, "STRANDED", ()))
    return covered


@pytest.fixture(scope="module")
def released() -> dict[str, str]:
    """Recipe version -> the commit its wheel was built from."""
    if not (REPO / ".git").exists():
        pytest.skip("needs git history to replay the release trees")
    if _git("rev-parse", "--is-shallow-repository").strip() == "true":
        # A shallow clone answers "no release commits" to every `git log -S`,
        # which silently turns the whole guard inside out: `released` is empty,
        # so nothing looks stranded and the tests below conclude the debt is
        # gone. That is a lie about the checkout, not a fact about the tree —
        # so say which it is. CI checks out at full depth for this reason
        # (.github/workflows/test.yml); a local shallow clone simply cannot
        # answer, and skipping beats asserting something untrue.
        pytest.skip("shallow clone — no release history to replay")
    return {v: c for v in _recipe_versions() if (c := _release_commit(v))}


@pytest.fixture(scope="module")
def never_shipped(released, tmp_path_factory) -> dict[str, str]:
    """Released version -> its release commit, for the ones whose own wheel did
    NOT carry their recipe. Replaying a release tree costs a ``git archive`` and
    a tar extract per version, so it is done once for the module."""
    tmp = tmp_path_factory.mktemp("release-trees")
    return {v: c for v, c in released.items() if not _shipped_in_own_wheel(v, c, tmp)}


def test_no_recipe_is_stranded(never_shipped) -> None:
    covered = _catch_up_coverage(never_shipped)
    stranded = [
        f"{version} (released in {commit[:9]})"
        for version, commit in sorted(never_shipped.items())
        if version not in covered
    ]
    assert not stranded, (
        "these recipes were added AFTER their own version shipped, so "
        "run_if_needed() can never find them and they will never run:\n  "
        + "\n  ".join(stranded)
        + "\nPut a NEW migration under the next unreleased version; repay an "
        "already-stranded one by naming it in that recipe's STRANDED tuple."
    )


def test_the_resolver_finds_a_recipe_that_did_ship(released, tmp_path: Path) -> None:
    """Control: the check is capable of passing, so a green run above means
    something. 0.2.26 shipped its recipe in its own wheel."""
    commit = released.get("0.2.26")
    if not commit:
        pytest.skip("0.2.26 not in this history")
    assert _shipped_in_own_wheel("0.2.26", commit, tmp_path)


def test_the_catch_up_actually_covers_the_stranded_history(never_shipped) -> None:
    """Guard against the covering recipe silently losing a version: everything
    that did NOT ship must be named, and nothing that DID ship should be."""
    covered = _catch_up_coverage(never_shipped)
    assert never_shipped, "history has no stranded recipes — this guard is obsolete"
    assert covered == set(never_shipped), (
        f"catch-up covers {sorted(covered)} but the stranded set is {sorted(never_shipped)}"
    )


def test_an_unreleased_recipe_exists_to_add_migrations_to(released) -> None:
    """A version with no bump commit yet is the only reachable place to put a
    new migration; without one the rule would forbid writing them at all."""
    unreleased = [v for v in _recipe_versions() if v not in released]
    assert unreleased, (
        "every recipe directory names an already-released version; a new "
        "migration has nowhere reachable to live"
    )
