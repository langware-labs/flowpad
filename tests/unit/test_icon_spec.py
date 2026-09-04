"""The icon vocabulary — that it loads, resolves, and refuses what it should.

The load-bearing test here is `test_every_emitted_name_resolves_exactly`.
Everything else checks a mechanism; that one is the fence, and it is what would
have caught the `GoogleDrive` / `HardDrive` drift while it was still a diff.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from flow_sdk.icons import IconRegistry, icons
from flow_sdk.icons.registry import icon_tag, kebab
from flow_sdk.schema.data_spec._kinds import register_builtin_kinds, resolve_kind
from flow_sdk.schema.data_spec.icon_spec import IconPackPayload, IconPackSpec, IconSpec
from flow_sdk.tags.grammar import is_valid_tag
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
        assert resolve_kind("icon.pack_payload") is IconPackPayload

    def test_misspelled_manifest_field_is_rejected(self):
        """`extra="forbid"` is inherited from DataSpec, and it is the point: a
        typo becomes a load error instead of a silently absent field."""
        with pytest.raises(ValidationError):
            IconSpec(kind="x", tintible=False)  # type: ignore[call-arg]
        with pytest.raises(ValidationError):
            IconPackSpec(kind="p", licence="MIT")  # type: ignore[call-arg]

    def test_a_spec_is_frozen(self):
        with pytest.raises(ValidationError):
            IconSpec(kind="x").kind = "y"


class TestTagGrammar:
    def test_every_shipped_tag_is_a_legal_tag(self):
        """Icons are named in the repo's ONE dot grammar. A pack that invented
        its own spelling would be exactly the mistake this replaced."""
        for pack in icons.packs:
            assert is_valid_tag(pack.kind), pack.kind
            for spec in pack.icons:
                assert is_valid_tag(f"{pack.kind}.{spec.kind}"), spec.kind
                for role in spec.sub:
                    assert is_valid_tag(f"{pack.kind}.{spec.kind}.{role}")

    def test_kebab_runs_before_normalization(self):
        """Order matters: normalizing first lowercases `BarChart3` to
        `barchart3` and the word boundaries the slug needs are gone."""
        assert kebab("BarChart3") == "bar-chart-3"
        assert icon_tag("BarChart3") == "bar-chart-3"

    def test_the_old_invented_grammar_is_gone(self):
        """`brands:slack` and `brands:claude@restore` failed the repo's own tag
        gate. Nothing should accept them again."""
        assert not is_valid_tag("brands:slack")
        assert not is_valid_tag("brands.claude@restore")
        assert icons.resolve("brands:slack") is None


class TestResolution:
    def test_a_full_tag_names_exactly_one_icon(self):
        res = icons.resolve("brands.slack")
        assert res and res.tag == "brands.slack" and res.exact

    def test_alias_resolves_to_the_canonical_tag(self):
        """Two call sites spelling the same icon differently must report the
        same identity, or the tag is not an identity."""
        for alias in ("Slack", "slack"):
            assert icons.resolve(alias).tag == "brands.slack"
        for alias in ("ClaudeCode", "Claude", "anthropic", "anthropic-key"):
            assert icons.resolve(alias).tag == "brands.claude"

    def test_bare_name_is_a_lookup_not_a_downgrade(self):
        """`Rss` naming no pack is answered by whichever pack has it. The caller
        asked by name and got that name's icon — nothing was degraded."""
        res = icons.resolve("Rss")
        assert res and res.tag == "lucide.rss" and res.exact

    def test_a_role_is_one_more_segment(self):
        res = icons.resolve("brands.claude.restore")
        assert res and res.tag == "brands.claude.restore" and res.exact
        assert res.sub_tag == "lucide.history"
        assert res.asset_path.endswith("claude.svg"), "composed, so the BASE artwork"

    def test_a_missing_role_degrades_to_the_base(self):
        """Best-match: an icon is decoration, and a base glyph beats nothing.
        The resolution says it happened so a caller can tell."""
        res = icons.resolve("brands.slack.restore")
        assert res and res.tag == "brands.slack" and not res.exact
        assert res.asked == "brands.slack.restore"

    def test_a_misspelled_leaf_on_a_valid_path_also_degrades(self):
        """The cost of best-match, recorded deliberately: this is why the fence
        below tests exactness rather than mere resolvability."""
        res = icons.resolve("brands.slack.typo")
        assert res and res.tag == "brands.slack" and not res.exact

    def test_a_bundle_pack_derives_its_leaf(self):
        res = icons.resolve("lucide.rss")
        assert res and res.asset_path == "icons/lucide/assets/rss.svg"

    def test_a_typo_does_not_resolve(self):
        """The whole reason the registry exists. A bundle pack vouches only for
        names it actually serves — otherwise `is_valid` answers True for
        anything and catches nothing."""
        assert icons.resolve("Nonexsitent") is None
        assert not icons.is_valid("Nonexsitent")
        assert not icons.is_valid("brands.nope")

    def test_a_path_is_a_location_not_a_name(self):
        assert icons.resolve("icons/my_type.svg") is None
        assert icons.is_valid("icons/my_type.svg")

    def test_empty(self):
        assert icons.resolve("") is None
        assert not icons.is_valid("")


class TestCollisions:
    """Two packs may declare the same leaf. That is not a collision — the full
    tag is the identity — and this is the behaviour the gallery demonstrates."""

    @pytest.fixture
    def two_packs(self, tmp_path: Path) -> IconRegistry:
        for kind, mark in (("demo-a", "a.svg"), ("demo-b", "b.svg")):
            d = tmp_path / kind
            (d / "assets").mkdir(parents=True)
            (d / "assets" / mark).write_text("<svg/>")
            (d / "icon_pack.json").write_text(
                json.dumps(
                    {
                        "kind": kind,
                        "base": f"icons/{kind}/assets",
                        "icons": [{"kind": "slack", "asset": mark}],
                    }
                )
            )
        return IconRegistry(root=tmp_path)

    def test_each_is_addressed_by_its_own_tag(self, two_packs: IconRegistry):
        assert two_packs.resolve("demo-a.slack").asset_path.endswith("a.svg")
        assert two_packs.resolve("demo-b.slack").asset_path.endswith("b.svg")

    def test_the_bare_leaf_is_arbitrary_but_stable(self, two_packs: IconRegistry):
        """Whichever pack answers first. It is arbitrary by definition — the
        point is that a caller who cares qualifies the tag."""
        res = two_packs.resolve("slack")
        assert res and res.tag in {"demo-a.slack", "demo-b.slack"}
        assert two_packs.resolve("slack").tag == res.tag, "stable within a process"

    def test_a_qualified_tag_never_consults_pack_order(self, two_packs: IconRegistry):
        """Reversing the order changes which pack answers the BARE leaf and
        nothing else — that is what "collisions are not a concept" means."""
        assert two_packs.resolve("demo-b.slack").pack == "demo-b"
        assert two_packs.resolve("demo-a.slack").pack == "demo-a"


class TestPacks:
    def test_every_declared_asset_exists(self):
        """A manifest pointing at artwork that is not there is a packaging bug
        that only shows up as a hole in the UI."""
        assert icons.missing_assets() == []

    def test_payload_publishes_what_a_bundle_pack_serves(self):
        by_kind = {p["kind"]: p for p in icons.payload()}
        assert by_kind["lucide"]["icons"] == []
        assert len(by_kind["lucide"]["served"]) > 50
        # An enumerated pack's `icons` already say; nothing is derived for it.
        assert by_kind["brands"]["served"] == []

    def test_the_travelling_shape_is_a_dataspec_that_round_trips(self):
        """`served` is derived and must never be authorable — but "derived" is
        not a reason to leave the type system. Patching the key into a
        `model_dump()` made the payload something no DataSpec could parse, which
        is what CLAUDE.md forbids for a shape that travels."""
        for blob in icons.payload():
            assert IconPackPayload(**blob).kind == blob["kind"]
        # The manifest shape still cannot carry it, which is the other half.
        with pytest.raises(ValidationError):
            IconPackSpec(kind="p", served=["x"])  # type: ignore[call-arg]

    def test_packs_are_shipped_in_the_wheel(self):
        """`server/icons/**/*` in pyproject's package-data is what carries these
        files into a pip install; without it the mount serves nothing."""
        assert "server/icons/**/*" in (REPO / "pyproject.toml").read_text()

    def test_a_dark_variant_is_only_meaningful_on_an_opaque_icon(self):
        """Masking discards the artwork's colour, so a tintable glyph with dark
        artwork is a contradiction — it would paint as one flat block."""
        for pack in icons.packs:
            for spec in pack.icons:
                if spec.dark:
                    assert not spec.tintable, f"{pack.kind}.{spec.kind}"


class TestTheFence:
    def test_every_emitted_name_resolves_exactly(self):
        """The check that pays for all of this.

        Until now nothing in Python could tell a real icon name from a typo —
        `TypeMetadata.icon` says so outright: *"the set of valid lucide names
        lives in the frontend's bundle, not here."*

        EXACTLY, not merely resolvably: best-match means a misspelled leaf on a
        valid path still returns a glyph, so `is_valid` alone would let
        `brands.slack.typo` through. Runtime degrades gracefully; CI does not.

        If this fails, either the name is wrong or the packs do not cover it;
        `uv run python scripts/build_lucide_icons.py` cuts the missing artwork.
        """
        emitted = emitted_names()
        assert len(emitted) > 60, "the scan found suspiciously few names — did a pattern break?"
        bad = {}
        for name, where in emitted.items():
            res = icons.resolve(name)
            if res is None:
                bad[name] = f"unresolved ({', '.join(sorted(where))})"
            elif not res.exact:
                bad[name] = f"only degraded to {res.tag} ({', '.join(sorted(where))})"
        assert not bad, f"icon names nothing serves exactly: {bad}"

    def test_every_sub_icon_tag_resolves(self):
        """A pack that badges `lucide.history` needs that file served, and
        nothing else in the codebase mentions it — miss it and a role renders a
        badge that 404s."""
        for pack in icons.packs:
            for spec in pack.icons:
                for role, tag in spec.sub.items():
                    res = icons.resolve(tag)
                    assert res and res.exact, f"{pack.kind}.{spec.kind}.{role} -> {tag}"

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
            for key in (spec.kind, *(icon_tag(a) for a in spec.aliases))
        }
        wanted = {k for k in (kebab(n) for n in emitted_names()) if k not in covered}
        assert wanted <= served, f"emitted but not served: {sorted(wanted - served)}"


class TestIsolation:
    def test_registry_reads_a_given_root(self, tmp_path: Path):
        """The registry takes its root as an argument, so a test never depends
        on what happens to be installed."""
        pack = tmp_path / "demo"
        pack.mkdir()
        (pack / "icon_pack.json").write_text(
            json.dumps({"kind": "demo", "base": "icons/demo", "icons": [{"kind": "thing", "asset": "t.svg"}]})
        )
        registry = IconRegistry(root=tmp_path)
        assert [p.kind for p in registry.packs] == ["demo"]
        assert registry.resolve("demo.thing").asset_path == "icons/demo/t.svg"
        assert registry.missing_assets() == ["demo.thing -> icons/demo/t.svg"]
