"""The icon vocabulary — that it loads, resolves, and refuses what it should.

The load-bearing test here is `test_every_emitted_name_resolves`. Everything else
checks a mechanism; that one is the fence, and it is the thing that would have
caught the `GoogleDrive` / `HardDrive` drift while it was still a diff.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from flow_sdk.icons import IconRegistry, icons
from flow_sdk.icons.registry import kebab
from flow_sdk.schema.data_spec._kinds import register_builtin_kinds, resolve_kind
from flow_sdk.schema.data_spec.icon_spec import IconPackSpec, IconSpec
from scripts.build_lucide_icons import emitted_names

REPO = Path(__file__).resolve().parent.parent.parent


class TestRegistration:
    def test_kinds_are_reachable(self):
        """The failure mode is SILENT — an unimported module leaves the kind
        resolving to `Any`, with no error anywhere — so this is the one that
        matters most about registration."""
        register_builtin_kinds()
        assert resolve_kind("icon") is IconSpec
        assert resolve_kind("icon.pack") is IconPackSpec

    def test_misspelled_manifest_field_is_rejected(self):
        """`extra="forbid"` is inherited from DataSpec, and it is the point: a
        typo becomes a load error instead of a silently absent field."""
        with pytest.raises(ValidationError):
            IconSpec(name="x", tintible=False)  # type: ignore[call-arg]
        with pytest.raises(ValidationError):
            IconPackSpec(name="p", licence="MIT")  # type: ignore[call-arg]

    def test_a_spec_is_frozen(self):
        with pytest.raises(ValidationError):
            IconSpec(name="x").name = "y"


class TestResolution:
    def test_bare_name_uses_pack_order(self):
        """Bespoke packs win a bare name, exactly as `lucideByName` checks its
        own table before lucide's exports."""
        assert [p.name for p in icons.packs] == ["brands", "flowpad", "lucide"]
        res = icons.resolve("Slack")
        assert res and (res.pack, res.spec.name) == ("brands", "slack")

    def test_qualified_name(self):
        res = icons.resolve("flowpad:wiki")
        assert res and res.pack == "flowpad"
        assert icons.resolve("flowpad:slack") is None

    @pytest.mark.parametrize(
        "alias,expected",
        [
            ("ClaudeCode", "claude"),
            ("Claude", "claude"),
            ("Google", "googledrive"),
            ("GoogleDrive", "googledrive"),
            ("gdrive", "googledrive"),
            ("anthropic-key", "anthropic"),
            ("openai-key", "openai"),
            ("PersonRaisedHand", "person-raised-hand"),
        ],
    )
    def test_aliases(self, alias, expected):
        """Two vocabularies are in shipped data — PascalCase from TypeInfo,
        lowercase from the process/provider tables. Aliases are what let one
        registry answer for both without renaming anything."""
        res = icons.resolve(alias)
        assert res and res.spec.name == expected

    def test_a_composed_role_keeps_the_base_and_names_a_sub_icon(self):
        """`@restore` is the base glyph plus a badge, not separate artwork. The
        repo previously carried four `*RestoreIcon` components that differed
        only in which mark sat under the same arrow; composition means a fifth
        vendor gets the role for free."""
        res = icons.resolve("brands:claude@restore")
        assert res and res.variant == "restore"
        assert res.asset_path.endswith("claude.svg")
        assert res.sub_ref == "lucide:history"

    def test_a_sub_icon_ref_resolves_like_any_other(self):
        """The badge goes through the same registry — which is why it can come
        from another pack and carry its own colour."""
        res = icons.resolve("brands:codex@restore")
        assert res
        badge = icons.resolve(res.sub_ref)
        assert badge and badge.asset_path.endswith("history.svg")

    def test_baked_artwork_wins_over_composition(self):
        """A vendor's own drawing beats a generic badge. Declaring both is not
        an error; the file simply wins."""
        from flow_sdk.schema.data_spec.icon_spec import IconPackSpec as _P

        pack = _P(
            name="p",
            base="icons/p",
            icons=[IconSpec(name="x", asset="x.svg", variants={"r": "x-r.svg"}, sub={"r": "lucide:history"})],
        )
        registry = IconRegistry()
        res = registry._resolution(pack, pack.icons[0], "r")
        assert res.asset_path == "icons/p/x-r.svg"
        assert res.sub_ref == ""

    def test_unknown_variant_is_a_miss_not_a_default(self):
        """Falling back to the default artwork would draw a fresh-session glyph
        where a restored one was asked for — a wrong answer, not a near one."""
        assert icons.resolve("brands:slack@restore") is None
        assert icons.resolve("brands:claude@nope") is None
        assert icons.resolve("Slack@restore") is None

    def test_bundle_pack_derives_its_path(self):
        res = icons.resolve("Rss")
        assert res and res.pack == "lucide"
        assert res.asset_path == "icons/lucide/assets/rss.svg"

    def test_bundle_pack_kebabs_a_compound_name(self):
        res = icons.resolve("BarChart3")
        assert res and res.asset_path.endswith("bar-chart-3.svg")

    def test_a_typo_does_not_resolve(self):
        """The whole reason the registry exists. A bundle pack vouches only for
        names it actually serves — otherwise `is_valid` would answer True for
        anything and catch nothing."""
        assert icons.resolve("Nonexsitent") is None
        assert not icons.is_valid("Nonexsitent")
        assert not icons.is_valid("brands:nope")

    def test_a_path_is_a_location_not_a_name(self):
        assert icons.resolve("icons/my_type.svg") is None
        assert icons.is_valid("icons/my_type.svg")

    def test_empty(self):
        assert icons.resolve("") is None
        assert not icons.is_valid("")


class TestPacks:
    def test_every_declared_asset_exists(self):
        """A manifest pointing at artwork that is not there is a packaging bug
        that only shows up as a hole in the UI."""
        assert icons.missing_assets() == []

    def test_payload_publishes_served_for_bundle_packs_only(self):
        """A bundle pack enumerates nothing, so the served set is derived from
        the directory and published — the static mount serves no directory
        index, and a hand-written list would be a second copy that drifts."""
        by_name = {p["name"]: p for p in icons.payload()}
        assert by_name["lucide"]["icons"] == []
        assert len(by_name["lucide"]["served"]) > 50
        assert "served" not in by_name["brands"]
        assert len(by_name["brands"]["icons"]) > 0

    def test_packs_are_shipped_in_the_wheel(self):
        """`server/icons/**/*` in pyproject's package-data is what carries these
        files into a pip install; without it the mount serves nothing."""
        pyproject = (REPO / "pyproject.toml").read_text()
        assert "server/icons/**/*" in pyproject


class TestTheFence:
    def test_every_emitted_name_resolves(self):
        """The check that pays for all of this.

        Until now nothing in Python could tell a real icon name from a typo —
        `TypeMetadata.icon` says so outright: *"the set of valid lucide names
        lives in the frontend's bundle, not here."* The consequence was that a
        name only failed at render time, silently, as a generic document glyph.

        If this fails, either the name is wrong or the packs do not cover it
        yet; `uv run python scripts/build_lucide_icons.py` cuts the missing
        artwork, and its `--check` mode is the CI form of this test.
        """
        emitted = emitted_names()
        assert len(emitted) > 60, "the scan found suspiciously few names — did a pattern break?"
        unresolved = {n: sorted(w) for n, w in emitted.items() if not icons.is_valid(n)}
        assert not unresolved, f"icon names nothing serves: {unresolved}"

    def test_every_sub_icon_ref_resolves(self):
        """A pack that badges `lucide:history` needs that file served, and
        nothing else in the codebase mentions it — miss it and `@restore`
        renders a badge that 404s."""
        for pack in icons.packs:
            for spec in pack.icons:
                for role, ref in spec.sub.items():
                    assert icons.is_valid(ref), f"{pack.name}:{spec.name}@{role} -> {ref}"

    def test_the_generator_is_not_stale(self):
        """The served set must equal the used set — that equality is what makes
        `is_valid` meaningful and what keeps the plain-HTML path from 404-ing."""
        lucide = next(p for p in icons.packs if p.is_bundle)
        served = set(icons.served(lucide))
        covered = {
            key
            for pack in icons.packs
            if not pack.is_bundle
            for spec in pack.icons
            for key in (spec.name, *spec.aliases)
        }
        sub_refs = {
            ref.split(":", 1)[-1]
            for pack in icons.packs
            for spec in pack.icons
            for ref in spec.sub.values()
        }
        wanted = {kebab(n) for n in set(emitted_names()) | sub_refs if n not in covered}
        assert wanted <= served, f"emitted but not served: {sorted(wanted - served)}"


class TestIsolation:
    def test_registry_reads_a_given_root(self, tmp_path: Path):
        """The registry takes its root as an argument, so a test never depends
        on what happens to be installed."""
        pack = tmp_path / "demo"
        pack.mkdir()
        (pack / "icon_pack.json").write_text(
            json.dumps({"name": "demo", "base": "icons/demo", "icons": [{"name": "thing", "asset": "t.svg"}]})
        )
        registry = IconRegistry(root=tmp_path)
        assert [p.name for p in registry.packs] == ["demo"]
        res = registry.resolve("thing")
        assert res and res.asset_path == "icons/demo/t.svg"
        assert registry.missing_assets() == ["demo:thing -> icons/demo/t.svg"]
