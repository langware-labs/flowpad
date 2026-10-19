"""The served token stylesheet must actually carry the product's tokens.

A page served out of a folder cannot use the app's Tailwind build, so
``/sdk/flowpad.css`` is generated from ``ui/src/styles/index.css`` — one source of
truth, extracted at build time. The failure mode this guards is silent: a parse
that matches nothing still writes a valid stylesheet, and the app it styles comes
out colourless in a way nobody traces back to the build.
"""

import pytest

import build_ui


@pytest.fixture(scope="module")
def rendered() -> str:
    return build_ui.render_flowpad_css(build_ui.TOKENS_CSS.read_text(encoding="utf-8"))


def _block(css: str, selector: str) -> str:
    start = css.index(selector + " {")
    return css[start : css.index("}", start)]


#: A spread across the palette rather than the whole list — enough that a
#: truncated or mis-anchored extraction cannot pass, without pinning the file's
#: contents so that adding a token becomes a test failure.
REQUIRED = (
    "--background",
    "--foreground",
    "--brand",
    "--primary",
    "--muted-foreground",
    "--destructive",
    "--border",
    "--ring",
    "--sidebar-background",
    "--chart-1",
)


@pytest.mark.parametrize("token", REQUIRED)
def test_both_themes_carry_the_token(rendered, token):
    for selector in (":root", ".dark"):
        assert f"{token}:" in _block(rendered, selector), f"{token} missing from {selector}"


def test_radius_is_light_only_and_inherited(rendered):
    # The app declares --radius once, on :root; .dark deliberately does not
    # redefine it. A "both themes" rule applied blindly would invent a value.
    assert "--radius:" in _block(rendered, ":root")
    assert "--radius:" not in _block(rendered, ".dark")


def test_no_tailwind_call_survives_in_a_token_value(rendered):
    # Extraction keeps only `--x: y;` lines, so at-rules cannot reach the output —
    # but a `theme()` call CAN, on the right-hand side of a token. A browser drops
    # the declaration silently, so the page loses exactly what this file supplies.
    assert "theme(" not in rendered


def test_the_radius_scale_matches_the_app(rendered):
    """The served scale is hand-written; the app derives it in tailwind.config.ts.

    Two statements of one fact, in two languages, with nothing tying them — so
    tie them here. Drift is silent otherwise: every served page just renders with
    slightly wrong geometry.
    """
    config = (build_ui.REPO_ROOT / "ui" / "tailwind.config.ts").read_text(encoding="utf-8")
    for name, expression in (
        ("lg", "var(--radius)"),
        ("md", "calc(var(--radius) - 2px)"),
        ("sm", "calc(var(--radius) - 4px)"),
    ):
        assert expression in config, f"tailwind.config.ts no longer derives radius {name} as {expression}"
        assert f"--radius-{name}: {expression};" in rendered


def test_a_missing_block_fails_loudly():
    # The whole point of raising: an empty extraction must not ship.
    with pytest.raises(ValueError, match="no `.nope"):
        build_ui.extract_token_block(":root { --a: 1; }", ".nope")
    with pytest.raises(ValueError, match="declares no tokens"):
        build_ui.extract_token_block(":root { color: red; }", ":root")
