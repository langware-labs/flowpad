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


def test_the_sheet_is_servable_as_is(rendered):
    # Nothing Tailwind-bearing may survive extraction: a browser given @tailwind
    # or @apply silently drops the rule, so the page loses exactly the styling
    # this file exists to provide.
    for directive in ("@tailwind", "@apply", "theme(", "@import"):
        assert directive not in rendered, f"{directive} is not servable to a browser"


def test_it_supplies_what_tokens_alone_cannot(rendered):
    # Tailwind's preflight gives the app its body font and tailwind.config.ts
    # derives the radius scale; a served page has neither.
    for expected in ("--font-sans", "--radius-md", ":focus-visible", "prefers-reduced-motion"):
        assert expected in rendered


def test_a_missing_block_fails_loudly(rendered):
    # The whole point of raising: an empty extraction must not ship.
    with pytest.raises(ValueError, match="no `.nope"):
        build_ui.extract_token_block(":root { --a: 1; }", ".nope")
    with pytest.raises(ValueError, match="declares no tokens"):
        build_ui.extract_token_block(":root { color: red; }", ":root")
